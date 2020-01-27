/**
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/.*
 */

import { Adapter, Device, Database, Property } from 'gateway-addon';

import crypto from 'crypto';

import fetch from 'node-fetch';

import { URLSearchParams, URL } from 'url';

interface Config {
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
            const url = new URL(property.url);

            if (property.queryParameters) {
                for (const param of property.queryParameters) {
                    url.searchParams.append(param.name, param.value);
                }
            }

            if (property.method === 'POST' || property.method === 'PUT') {
                let body = '';

                switch (property.contentType) {
                    case 'application/x-www-form-urlencoded': {
                        const params = new URLSearchParams();

                        if (property.bodyParameters) {
                            for (const param of property.bodyParameters) {
                                params.append(param.name, param.value);
                            }
                        }

                        body = params.toString();
                        break;
                    }
                    case 'application/json': {
                        const obj: any = {};

                        if (property.bodyParameters) {
                            for (const param of property.bodyParameters) {
                                obj[param.name] = param.value;
                            }
                        }

                        body = JSON.stringify(obj);
                        break;
                    }
                }

                const result = await fetch(url.toString(), {
                    method: property.method.toLowerCase(),
                    headers: {
                        'Content-Type': property.contentType
                    },
                    body
                });

                console.log(`Server responded with ${result.status}: ${result.statusText}`);
                const response = await result.text();
                this.setCachedValueAndNotify(response);
            } else {
                const result = await fetch(url.toString(), {
                    method: property.method.toLowerCase()
                });

                console.log(`Server responded with ${result.status}: ${result.statusText}`);
                const response = await result.text();
                this.setCachedValueAndNotify(response);
            }
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
                    console.log(`url: ${action.url}`);
                    const url = new URL(action.url);

                    if (action.queryParameters) {
                        for (const param of action.queryParameters) {
                            url.searchParams.append(param.name, param.value);
                        }
                    }

                    if (action.method === 'POST' || action.method === 'PUT') {
                        let body = '';

                        switch (action.contentType) {
                            case 'application/x-www-form-urlencoded': {
                                const params = new URLSearchParams();

                                if (action.bodyParameters) {
                                    for (const param of action.bodyParameters) {
                                        params.append(param.name, param.value);
                                    }
                                }

                                body = params.toString();
                                break;
                            }
                            case 'application/json': {
                                const obj: any = {};

                                if (action.bodyParameters) {
                                    for (const param of action.bodyParameters) {
                                        obj[param.name] = param.value;
                                    }
                                }

                                body = JSON.stringify(obj);
                                break;
                            }
                        }

                        const result = await fetch(url.toString(), {
                            method: action.method.toLowerCase(),
                            headers: {
                                'Content-Type': action.contentType
                            },
                            body
                        });

                        console.log(`Server responded with ${result.status}: ${result.statusText}`);
                    } else {
                        const result = await fetch(url.toString(), {
                            method: action.method.toLowerCase()
                        });

                        console.log(`Server responded with ${result.status}: ${result.statusText}`);
                    }
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
            actions,
            devices
        } = config;

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
