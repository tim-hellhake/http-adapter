/**
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/.*
 */

import { Adapter, Device, Database, Property } from 'gateway-addon';

import crypto from 'crypto';

import fetch, { RequestInit, Response } from 'node-fetch';

import { URLSearchParams, URL } from 'url';

import {
    AListOfHTTPActions,
    AListOfHTTPProperties,
    AnAction,
    AProperty,
    Config,
    TheIDOfTheDeviceWillBeGeneratedForYou,
    TheListOfCapabilitiesOfTheDevice,
    TheNameOfTheDevice
} from './config';

async function execute(info: AnAction | AProperty): Promise<Response> {
    verbose(`url: ${info.url}`);
    const url = new URL(info.url);

    if (info.queryParameters) {
        for (const param of info.queryParameters) {
            url.searchParams.append(param.name, param.value);
        }
    }

    const additionalOptions: RequestInit = {}

    if (info.method === 'POST' || info.method === 'PUT') {
        additionalOptions.headers = {
            'Content-Type': info.contentType
        };

        switch (info.contentType) {
            case 'application/x-www-form-urlencoded': {
                const params = new URLSearchParams();

                if (info.bodyParameters) {
                    for (const param of info.bodyParameters) {
                        params.append(param.name, param.value);
                    }
                }

                additionalOptions.body = params.toString();
                break;
            }
            case 'application/json': {
                const obj: any = {};

                if (info.bodyParameters) {
                    for (const param of info.bodyParameters) {
                        obj[param.name] = param.value;
                    }
                }

                additionalOptions.body = JSON.stringify(obj);
                break;
            }
        }
    }

    const start = new Date().getTime();

    const result = await fetch(url.toString(), {
        method: info.method.toLowerCase(),
        ...additionalOptions
    });

    const diff = new Date().getTime() - start;

    verbose(`Server responded with ${result.status}: ${result.statusText} in ${diff} ms`);

    return result;
}

interface DeviceTemplate {
    id?: TheIDOfTheDeviceWillBeGeneratedForYou;
    name: TheNameOfTheDevice;
    types?: TheListOfCapabilitiesOfTheDevice;
    actions?: AListOfHTTPActions;
    properties?: AListOfHTTPProperties;
}

let verbose: (message?: any, ...optionalParams: any[]) => void

class HttpProperty extends Property {
    constructor(device: HttpDevice, property: AProperty) {
        super(device, property.name, {
            title: property.name,
            type: property.responseType ?? 'string',
            readonly: true
        });

        if (property.type) {
            this['@type'] = property.type;
        }

        if (property.unit) {
            this['unit'] = property.unit;
        }

        if (property.minimum) {
            this['minimum'] = property.minimum;
        }

        if (property.maximum) {
            this['maximum'] = property.maximum;
        }

        setInterval(async () => {
            const response = await execute(property);
            const text = await response.text();
            let value: any = text;

            switch (this.type) {
                case 'number':
                    value = parseFloat(value);
                    break;
                case 'integer':
                    value = parseInt(value);
                    break;
                case 'boolean':
                    value = !!value;
                    break;
            }

            this.setCachedValueAndNotify(value);
        }, (property.pollInterval ?? 1) * 1000)
    }
}

class HttpDevice extends Device {
    private callbacks: { [name: string]: () => void } = {};

    constructor(adapter: any, device: DeviceTemplate) {
        super(adapter, <string>device.id);
        this['@context'] = 'https://iot.mozilla.org/schemas/';
        this['@type'] = device.types ?? [];
        this.title = device.name;

        if (device.actions) {
            for (const action of device.actions) {
                this.addCallbackAction(action, async () => execute(action));
            }
        }

        if (device.properties) {
            for (const property of device.properties) {
                const httpProperty = new HttpProperty(this, property);
                this.properties.set(httpProperty.name, httpProperty);
            }
        }
    }

    addCallbackAction(action: AnAction, callback: () => void) {
        const additionalProperties: Record<string, unknown> = {};

        const {
            type,
            name,
            description
        } = action;

        if (type) {
            additionalProperties['@type'] = type;
        }

        if (description) {
            additionalProperties.description = description;
        }

        this.addAction(name, {
            title: name,
            ...additionalProperties
        });

        this.callbacks[name] = callback;
    }

    async performAction(action: any) {
        action.start();

        const callback = this.callbacks[action.name];

        if (callback) {
            callback();
        } else {
            console.warn(`Unknown action ${action.name}`);
        }

        action.finish();
    }
}

export class HttpAdapter extends Adapter {
    private readonly database: Database;

    constructor(addonManager: any, manifest: any) {
        super(addonManager, HttpAdapter.name, manifest.name);
        this.database = new Database(manifest.name)
        addonManager.addAdapter(this);
        this.createDevices();
    }

    private async createDevices() {
        const devices = await this.loadDevices();

        if (devices) {
            for (const device of devices) {
                const http = new HttpDevice(this, device);
                this.handleDeviceAdded(http);
            }
        }
    }

    private async loadDevices() {
        await this.database.open();
        const config: Config = await this.database.loadConfig();
        let {
            debug,
            devices
        } = config;

        if (debug) {
            verbose = console.log;
        } else {
            verbose = () => { };
        }

        if (!devices) {
            devices = [];
        }

        for (let device of devices) {
            if (!device.id) {
                device.id = `http-${crypto.randomBytes(16).toString("hex")}`;
                console.log(`Generated id ${device.id} for ${device.name}`);
            }
        }

        await this.database.saveConfig(config);

        return devices;
    }
}
