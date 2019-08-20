/**
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/.*
 */

import { Adapter, Device, Database } from 'gateway-addon';

import crypto from 'crypto';

import fetch from 'node-fetch';

interface Action {
    id: string,
    name: string,
    url: string,
    parameters: Parameter[]
}

interface Parameter {
    name: string,
    value: string
}

class HttpDevice extends Device {
    private callbacks: { [name: string]: () => void } = {};

    constructor(adapter: any, action: Action) {
        super(adapter, action.id);
        this['@context'] = 'https://iot.mozilla.org/schemas/';
        this.name = action.name;

        this.addCallbackAction('invoke', 'Invoke the action', async () => {
            const body = action.parameters
                .map(parameter => `${parameter.name}=${encodeURIComponent(parameter.value)}`)
                .reduce((acc, s) => `${acc}&${s}`, '');

            await fetch(action.url, {
                method: 'post',
                headers: {
                    'Content-Type': 'application/x-www-form-urlencoded'
                },
                body
            });
        });
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
        this.createActions();
    }

    private async createActions() {
        const actions = await this.loadActions();

        if (actions) {
            for (const action of actions) {
                const http = new HttpDevice(this, action);
                this.handleDeviceAdded(http);
            }
        }
    }

    private async loadActions() {
        await this.database.open();
        const config = await this.database.loadConfig();
        const {
            actions
        } = config;

        if (actions) {
            for (const action of actions) {
                if (!action.id) {
                    action.id = crypto.randomBytes(16).toString("hex");
                }
            }
        }

        await this.database.saveConfig(config);
        return actions;
    }
}
