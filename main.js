"use strict";

/*
 * Created with @iobroker/create-adapter v2.3.0
 */

/* eslint-disable no-useless-escape */
const utils = require("@iobroker/adapter-core");
const axios = require("axios").default;

class Cloudflare extends utils.Adapter {
    /**
     * @param options Options
     */
    constructor(options) {
        super({
            ...options,
            name: "cloudflare",
        });
        this.on("ready", this.onReady.bind(this));
        this.on("unload", this.onUnload.bind(this));
    }

    // Ready
    async onReady() {
        this.setState("info.connection", false, true);

        if (
            this.config.authEmail == null ||
            this.config.authEmail == "" ||
            this.config.authEmail == "example@gmail.com"
        ) {
            this.log.warn("Auth Email cannot be null or be example@gmail.com, disabling adapter!");
            return;
        }

        if (this.config.authMethod != "global" && this.config.authMethod != "token") {
            this.log.warn("Auth Method was not global or token, disabling adapter!");
            return;
        }

        if (this.config.authKey == null || this.config.authEmail == "") {
            this.log.warn("Auth Key cannot be null, disabling adapter!");
            return;
        }

        if (this.config.zoneIdentifier == null || this.config.zoneIdentifier == "") {
            this.log.warn("Zone Identifier cannot be null, disabling adapter!");
            return;
        }

        if (this.config.recordName == null || this.config.recordName == "" || this.config.recordName == "example.org") {
            this.log.warn("Record Name cannot be null or be example.org, disabling adapter!");
            return;
        }

        if (this.config.ttl <= -1) {
            this.log.warn("TTL was under 0, disabling adapter!");
            return;
        }

        if (this.config.proxy != true && this.config.proxy != false) {
            this.log.warn("Proxy was not true or false, disabling adapter!");
            return;
        }

        if (this.config.checkInterval < 30) {
            this.log.warn("checkInterval may not be under 30 seconds to prevent ratelimits.");
            this.config.checkInterval = 30;
        }

        this.auth_header = this.config.authMethod == "global" ? "X-Auth-Key" : "Authorization";
        this.updateInterval = null;
        this.notChangedNotified = false;

        this.requestClient = axios.create({
            timeout: 10000,
            headers: {
                "X-Auth-Email": this.config.authEmail,
                "Content-Type": "application/json",
                Accept: "application/json",
            },
        });

        this.requestClient.defaults.headers.common[`${this.auth_header}`] =
            `${this.config.authMethod == "token" ? "Bearer " : ""}${this.config.authKey}`;
        this.requestClient.defaults.validateStatus = function () {
            return true;
        };

        this.updateInterval = setInterval(async () => {
            await this.updateDDNS();
        }, this.config.checkInterval * 1000);

        this.setState("info.connection", true, true);
    }

    onUnload(callback) {
        try {
            this.updateInterval && clearInterval(this.updateInterval);
            this.setState("info.connection", false, true);
            callback();
        } catch (e) {
            this.log.error(e);
            callback();
        }
    }

    async updateDDNS() {
        const ipv4_regex = new RegExp(
            "([01]?[0-9]?[0-9]|2[0-4][0-9]|25[0-5])\.([01]?[0-9]?[0-9]|2[0-4][0-9]|25[0-5])\.([01]?[0-9]?[0-9]|2[0-4][0-9]|25[0-5])\.([01]?[0-9]?[0-9]|2[0-4][0-9]|25[0-5])",
        );

        if (this.requestClient == null) {
            this.log.error("requestClient was null, restarting adapter to retrying creating it");
            return this.restart();
        }

        let ip = await this.requestClient({ url: "https://api.ipify.org" })
            .then(r => r.data)
            .catch(err => this.log.error(`Error while trying to get public Ip Address: ${err.message}`));

        if (!ipv4_regex.test(ip)) {
            this.log.warn("Failed to find a valid IP. Retrying with different hoster.");
            ip = await this.requestClient({ url: "https://ipv4.icanhazip.com" })
                .then(r => r.data)
                .catch(err =>
                    this.log.error(`Error while trying to get public ip address from second provider: ${err.message}`),
                );
        }

        if (!ipv4_regex.test(ip)) {
            this.log.error("Failed to find a valid IP. Retrying has failed.");
            return;
        }

        const searchRecord = await this.requestClient({
            url: `https://api.cloudflare.com/client/v4/zones/${this.config.zoneIdentifier}/dns_records?type=A&name=${this.config.recordName}`,
        })
            .then(r => r.data)
            .catch(err => this.log.error(`Error while trying to find the record on Cloudflare: ${err.message}`));

        if (searchRecord.success == false) {
            let errors = "";
            for (const error of searchRecord.errors) {
                errors += `Code: ${error.code} | Message: ${error.message} \n`;
            }
            this.log.error(`Errors while searching for Record\nError Reads: ${errors}`);
            return;
        }

        if (searchRecord.result_info.count == 0) {
            this.log.error(`Record does not exist!, perhaps create one first? (${ip} for ${this.config.recordName})`);
            return;
        }

        if (ip == searchRecord.result[0].content) {
            if (this.notChangedNotified == false) {
                this.log.info(`IP (${ip}) for ${this.config.recordName} has not changed.`);
                this.notChangedNotified = true;
            }
            return;
        }

        this.notChangedNotified = false;

        const recordIdentifier = searchRecord.result[0].id;
        const updateRecord = await this.requestClient({
            method: "PATCH",
            url: `https://api.cloudflare.com/client/v4/zones/${this.config.zoneIdentifier}/dns_records/${recordIdentifier}`,
            data: JSON.stringify({
                type: "A",
                name: this.config.recordName,
                content: ip,
                ttl: this.config.ttl,
                proxied: this.config.proxy,
            }),
        })
            .then(r => r.data)
            .catch(err => this.log.error(`Error while trying to update record with public ip address: ${err.message}`));
        if (updateRecord.success == true) {
            this.log.info(`${ip} ${this.config.recordName} DDNS updated.`);
        } else {
            let errors = "";
            for (const error of updateRecord.errors) {
                errors += `Code: ${error.code} | Message: ${error.message} \n`;
            }
            this.log.error(`Errors while updating record\nError Reads: ${errors}`);
        }
    }
}

if (require.main !== module) {
    module.exports = options => new Cloudflare(options);
} else {
    new Cloudflare();
}
