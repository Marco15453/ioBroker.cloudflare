"use strict";

/*
 * Created with @iobroker/create-adapter v2.3.0
 */

/* eslint-disable no-useless-escape */
const utils = require("@iobroker/adapter-core");
const axios = require('axios')

class Cloudflare extends utils.Adapter {

	/**
	 * @param {Partial<utils.AdapterOptions>} [options={}]
	 */
	constructor(options) {
		super({
			...options,
			name: "cloudflare",
		});
		this.on("ready", this.onReady.bind(this));
		this.on("unload", this.onUnload.bind(this));
	}

	async onReady() {
		this.setState("info.connection", false, true);

		if(this.config.authEmail == null || this.config.authEmail == "" || this.config.authEmail == "example@gmail.com") {
			this.log.error('Auth Email cannot be null or be example@gmail.com, disabling adapter!')
			return
		}

		if(this.config.authMethod != 'global' && this.config.authMethod != 'token') {
			this.log.error('Auth Method was not global or token, disabling adapter!')
			return
		}

		if(this.config.authKey == null || this.config.authEmail == "") {
			this.log.error('Auth Key cannot be null, disabling adapter!')
			return
		}

		if(this.config.zoneIdentifier == null || this.config.zoneIdentifier == "") {
			this.log.error('Zone Identifier cannot be null, disabling adapter!')
			return
		}

		if(this.config.recordName == null || this.config.recordName == "" || this.config.recordName == "example.org") {
			this.log.error('Record Name cannot be null or be example.org, disabling adapter!')
			return
		}

		if(this.config.ttl <= -1) {
			this.log.error('TTL was under 0, disabling adapter!')
			return
		}

		if(this.config.proxy != true && this.config.proxy != false) {
			this.log.error('Proxy was not true or false, disabling adapter!')
			return
		}

		this.auth_header = this.config.authMethod == 'global' ? 'X-Auth-Key' : 'Authorization'
		this.updateInterval = null
		this.notChangedNotified = false

		this.requestClient = axios.create({
			headers: {
				'X-Auth-Email': this.config.authEmail,
				'Content-Type': 'application/json',
				'Accept': 'application/json'
			}
		});

		this.requestClient.defaults.headers.common[`${this.auth_header}`] = `${this.config.authMethod == 'token' ? 'Bearer ' : ''}${this.config.authKey}`
		this.requestClient.defaults.validateStatus = function() {
			return true
		}

		await this.updateDDNS()
		this.updateInterval = setInterval(async () => {
			await this.updateDDNS()
		}, this.config.checkInterval * 1000)

		this.setState("info.connection", true, true);
	}

	onUnload(callback) {
		try {
			this.setState('info.connection', false, true)

			this.updateInterval && clearInterval(this.updateInterval)
			callback();
		} catch (e) {
			callback();
		}
	}

	async updateDDNS() {
		const ipv4_regex = new RegExp('([01]?[0-9]?[0-9]|2[0-4][0-9]|25[0-5])\.([01]?[0-9]?[0-9]|2[0-4][0-9]|25[0-5])\.([01]?[0-9]?[0-9]|2[0-4][0-9]|25[0-5])\.([01]?[0-9]?[0-9]|2[0-4][0-9]|25[0-5])')

		const ip = await this.requestClient({url: 'https://api.ipify.org'}).then(r => r.data)

		if (!ipv4_regex.test(ip)) {
			this.log.warn('Failed to find a valid IP.')
			this.sendLogging(`Failed to find a valid IP.`, 'warn')
			return
		}

		const searchRecord = await this.requestClient({url: `https://api.cloudflare.com/client/v4/zones/${this.config.zoneIdentifier}/dns_records?type=A&name=${this.config.recordName}`}).then(r => r.data)

		if(searchRecord.success == false) {
			let errors = ""
			for (const error of searchRecord.errors) {
				errors += `Code: ${error.code} | Message: ${error.message} \n`
			}
			this.log.error(`Errors while searching for Record\nError Reads: ${errors}`)
			this.sendLogging(`Errors while searching for Record\nError Reads:\n${errors}`, 'error')
			return
		}

		if(searchRecord.result_info.count == 0) {
			this.log.warn(`Record does not exist!, perhaps create one first? (${ip} for ${this.config.recordName})`)
			this.sendLogging(`Record does not exist!, perhaps create one first? (${ip} for ${this.config.recordName})`, 'warn')
			return
		}

		if(ip == searchRecord.result[0].content) {
			if (this.notChangedNotified == false) {
				this.log.info(`IP (${ip}) for ${this.config.recordName} has not changed.`)
				this.sendLogging(`IP (${ip}) for ${this.config.recordName} has not changed.`, 'info')
				this.notChangedNotified = true
			}
			return
		}

		this.notChangedNotified = false

		const recordIdentifier = searchRecord.result[0].id
		const updateRecord = await this.requestClient({method: 'PATCH', url: `https://api.cloudflare.com/client/v4/zones/${this.config.zoneIdentifier}/dns_records/${recordIdentifier}`, data: JSON.stringify({"type": "A", "name": this.config.recordName, "content": ip, "ttl": this.config.ttl, "proxied": this.config.proxy})}).then(r => r.data)
		if(updateRecord.success == true) {
			this.log.info(`${ip} ${this.config.recordName} DDNS updated.`)
			this.sendLogging(`${this.config.siteName} Updated: ${this.config.recordName}'s new IP Address is ${ip}`, 'info')
		} else {
			let errors = ""
			for (const error of updateRecord.errors) {
				errors += `Code: ${error.code} | Message: ${error.message} \n`
			}
			this.log.error(`Errors while updating record\nError Reads: ${errors}`)
			this.sendLogging(`Errors while updating record\nError Reads:\n${errors}`, 'error')
		}
	}

	async sendLogging(message, type) {
		if(this.config.slackUri != null && this.config.slackUri != "") {
			if(type == 'info') {
				await this.requestClient({method: 'POST', url: this.config.slackUri, data: JSON.stringify({"channel": this.config.slackChannel, "text": `[INFO] IoBroker CloudFlare: ${message}`})})
			} else if(type == 'warn') {
				await this.requestClient({method: 'POST', url: this.config.slackUri, data: JSON.stringify({"channel": this.config.slackChannel, "text": `[WARN] IoBroker CloudFlare: ${message}`})})
			} else if(type == 'error') {
				await this.requestClient({method: 'POST', url: this.config.slackUri, data: JSON.stringify({"channel": this.config.slackChannel, "text": `[ERROR] IoBroker CloudFlare: ${message}`})})
			}
		}

		if(this.config.discordUri != null && this.config.discordUri != "") {
			if(type == 'info') {
				await this.requestClient({method: 'POST', url: this.config.discordUri, data: JSON.stringify({"content": `[INFO] IoBroker CloudFlare: ${message}`})})
			} else if(type == 'warn') {
				await this.requestClient({method: 'POST', url: this.config.discordUri, data: JSON.stringify({"content": `[WARN] IoBroker CloudFlare: ${message}`})})
			} else if(type == 'error') {
				await this.requestClient({method: 'POST', url: this.config.discordUri, data: JSON.stringify({"content": `[ERROR] IoBroker CloudFlare: ${message}`})})
			}
		}
	}
}

if (require.main !== module) {
	module.exports = (options) => new Cloudflare(options);
} else {
	new Cloudflare();
}