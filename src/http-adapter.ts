/**
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/.*
 */

import { Adapter, Device, Database, Property } from 'gateway-addon';

import crypto from 'crypto';

import fetch, { RequestInit, Response } from 'node-fetch';

import { URLSearchParams, URL } from 'url';

async function execute(info: Action | PropertyInfos): Promise<Response> {
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

    const result = await fetch(url.toString(), {
        method: info.method.toLowerCase(),
        ...additionalOptions
    });

    verbose(`Server responded with ${result.status}: ${result.statusText}`);

    return result;
}

let verbose: (message?: any, ...optionalParams: any[]) => void

interface Config {
    debug: boolean,
    actions?: LegacyAction[],
    devices?: DeviceTemplate[]
}

interface DeviceTemplate {
    id: string,
    name: string,
    actions?: Action[],
    properties?: PropertyInfos[]
}

interface Action {
    name: string,
    description: string,
    url: string,
    method: string,
    contentType: string,
    queryParameters?: Parameter[],
    bodyParameters?: Parameter[]
}

interface PropertyInfos {
    name: string,
    description: string,
    url: string,
    method: string,
    contentType: string,
    queryParameters?: Parameter[],
    bodyParameters?: Parameter[],
    pollInterval: number
}

interface LegacyAction extends Action {
    id: string
}

interface Parameter {
    name: string,
    value: string
}

class HttpProperty extends Property {
    constructor(device: HttpDevice, property: PropertyInfos) {
        super(device, property.name, {
            title: property.name,
            type: 'string'
        });

        setInterval(async () => {
            const response = await execute(property);
            this.setCachedValueAndNotify(response.text);
        }, (property.pollInterval ?? 1) * 1000)
    }
}

class HttpDevice extends Device {
    private callbacks: { [name: string]: () => void } = {};

    constructor(adapter: any, device: DeviceTemplate) {
        super(adapter, device.id);
        this['@context'] = 'https://iot.mozilla.org/schemas/';
        this.name = device.name;

        if (device.actions) {
            for (const action of device.actions) {
                this.addCallbackAction(action.name, action.description, async () => {
                    execute(action);
                });
            }
        }

        if (device.properties) {
            for (const property of device.properties) {
                const httpProperty = new HttpProperty(this, property);
                this.properties.set(httpProperty.name, httpProperty);
            }
        }
    }

    addCallbackAction(title: string, description: string, callback: () => void) {
        this.addAction(title, {
            title,
            description
        });

        this.callbacks[title] = callback;
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
            actions,
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

        // Transition old schema to new
        if (actions) {
            console.log('Migrate from old schema');

            for (const action of actions) {
                const device: DeviceTemplate = {
                    id: action.id,
                    name: action.name,
                    actions: [
                        {
                            name: 'invoke',
                            description: 'Invoke the action',
                            url: action.url,
                            method: action.method,
                            contentType: action.contentType,
                            queryParameters: action.queryParameters,
                            bodyParameters: action.bodyParameters,
                        },
                    ],
                };

                devices.push(device);
            }

            delete config.actions;
            config.devices = devices;
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
