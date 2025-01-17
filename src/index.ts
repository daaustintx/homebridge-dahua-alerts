import {
	API,
	IndependentPlatformPlugin,
	Logging,
	PlatformConfig
} from 'homebridge'
import { DahuaCameraConfig, CameraConfig, CameraCredentials } from './configTypes'
import axios, { AxiosError } from 'axios'
import { DahuaError, DahuaEvents, DahuaAlarm } from './dahua'

const PLUGIN_NAME = 'homebridge-dahua-alerts'
const PLATFORM_NAME = 'dahua-alerts'

export = (api: API) => {
	api.registerPlatform(PLUGIN_NAME, PLATFORM_NAME, DahuaMotionAlertsPlatform)
}

class DahuaMotionAlertsPlatform implements IndependentPlatformPlugin {
	private readonly log: Logging
	private readonly config: DahuaCameraConfig 
	constructor(log: Logging, config: PlatformConfig) {
		this.log = log
		this.config = config as unknown as DahuaCameraConfig
		
		if(this.isInvalidConfig(this.config)) {
			this.log.error('Errors above, shutting plugin down')
			return
		} else {
			//find all uniqueHosts in config in order to only setup one "DahuaEvents" (socket) connection per unique host
			let uniqueHosts = new Map<string, DahuaEventsConfig>()
			if(config.host) {
				uniqueHosts.set(config.host, {
					events: new Set<string>(), 
					server: {host: config.host, user: config.user, pass: config.pass, useHttp: config.useHttp} as CameraCredentials
				} as DahuaEventsConfig)
			}
			this.config.cameras.forEach(camera => {
				let hostConfig: DahuaEventsConfig

				// group hosts
				if(camera.cameraCredentials && !uniqueHosts.has(camera.cameraCredentials.host)) {
					hostConfig = {events: new Set<string>(), server: camera.cameraCredentials} as DahuaEventsConfig
					uniqueHosts.set(camera.cameraCredentials.host, hostConfig)
				} else if (camera.cameraCredentials) {
					hostConfig = uniqueHosts.get(camera.cameraCredentials.host)!;
				} else {
					hostConfig = uniqueHosts.get(config.host)!;
				}

				// group subscribed events
				camera.triggerEventTypes.forEach(hostConfig.events.add, hostConfig.events)
			})
			uniqueHosts.forEach(hostConfig => {
				let events: DahuaEvents = new DahuaEvents(hostConfig.server.host, hostConfig.server.user, 
					hostConfig.server.pass, hostConfig.server.useHttp, hostConfig.events);
		
				events.getEventEmitter().on(events.ALARM_EVENT_NAME, this.alertMotion)
				events.getEventEmitter().on(events.ERROR_EVENT_NAME, (data: DahuaError) => { 
					this.log.error(`${data.error} (for more info enable debug logging)`)
					this.log.debug(`${data.errorDetails}`)
				})
				events.getEventEmitter().on(events.DEBUG_EVENT_NAME, (data) => this.log.debug(data))
				events.getEventEmitter().on(events.RECONNECTING_EVENT_NAME, (data) => this.log.debug(data))
			})
		}
	}

	private alertMotion = (dahuaAlarm: DahuaAlarm) => {
		let cameraName = this.getCameraName(dahuaAlarm)
		if(cameraName) {
			if (dahuaAlarm.action === 'Start') {
				this.log.debug(`${dahuaAlarm.eventType} detected on index: ${dahuaAlarm.index}, mapped to camera ${cameraName}`)
				axios.post(this.motionUrl(cameraName)).then(res => {
					this.log.info(`${dahuaAlarm.eventType} motion for ${cameraName} posted to homebridge-camera-ffmpeg, received`, res.data)
				}).catch((err: AxiosError) => {
					let msg = 'Error when posting video motion to homebridge-camera-ffmpeg'
					if(err.response) {
						this.log.error(`${msg} - Status Code: ${err.response.status} Response: ${err.response.data.statusMessage}`)
					} else if(err.request) {
						this.log.error(`${msg} - didn't get a response from homebridge-camera-ffmpeg - ${err.message}`)
					} else {
						this.log.error(`${msg}`)
					}
				})
			} else if (dahuaAlarm.action === 'Stop')	{
				this.log.debug(`${dahuaAlarm.eventType} ended on index: ${dahuaAlarm.index}, mapped to camera ${cameraName}`)
				axios.post(this.resetMotionUrl(cameraName)).then(res => {
					this.log.info(`Reset ${dahuaAlarm.eventType} motion for ${cameraName} posted to homebridge-camera-ffmpeg, received`, res.data)
				}).catch((err: AxiosError) => {
					let msg = 'Error when posting reset video motion to homebridge-camera-ffmpeg'
					if(err.response) {
						this.log.error(`${msg} - Status Code: ${err.response.status} Response: ${err.response.data.statusMessage}`)
					} else if(err.request) {
						this.log.error(`${msg} - didn't get a response from homebridge-camera-ffmpeg - ${err.message}`)
					} else {
						this.log.error(`${msg}`)
					}
				})
			}
		}
	}

	private motionUrl = (cameraName: string): string => {
		return encodeURI(`http://localhost:${this.config.homebridgeCameraFfmpegHttpPort}/motion?${cameraName}`)
	}

	private resetMotionUrl = (cameraName: string): string => {
		return encodeURI(`http://localhost:${this.config.homebridgeCameraFfmpegHttpPort}/motion/reset?${cameraName}`)
	}

	private getCameraName = (alarm: DahuaAlarm): (string | null)  => {
		for(let i = 0; i < this.config.cameras.length; i++) {
			let camera = this.config.cameras[i]
			if(camera.index === alarm.index) {
				if((camera.cameraCredentials && camera.cameraCredentials.host === alarm.host && camera.triggerEventTypes.includes(alarm.eventType)) || 
					(!camera.cameraCredentials && this.config.host && this.config.host === alarm.host && camera.triggerEventTypes.includes(alarm.eventType))) {
						return camera.cameraName
					}
			}
		}
		return null
	}

	private isInvalidConfig = (config: DahuaCameraConfig): boolean => {
		let error = false

		if(!config.homebridgeCameraFfmpegHttpPort) {
			this.log.error('homebridge-camera-ffmpeg http port not set in config!')
			error = true
		} else if(!config.cameras || config.cameras.length === 0) {
			this.log.error('no cameras configured!')
			error = true
		} else if((config.host || config.user || config.pass) && this.invalidCameraCredentials({host: config.host, user: config.user, pass: config.pass} as CameraCredentials)) {
			error = true
		} else {
			config.cameras.forEach((camera: CameraConfig) => {
				if(!camera.cameraName || (!camera.index && camera.index !== 0)) {
					this.log.error('no camera name or index set!')
					error = true
					return
				} else if (!camera.triggerEventTypes || camera.triggerEventTypes.length == 0) {
					this.log.error('no trigger event types!')
					error = true
					return
				/*if it has camera credentials and it's invalid */
				} else if(camera.cameraCredentials && this.invalidCameraCredentials(camera.cameraCredentials)) {
					error = true
					return error					
				} 
			})
		}

		return error
	}

	private invalidCameraCredentials(config: CameraCredentials) {
		let error = false
		
		if(!config.host) {
			this.log.error('host not set!')
			error = true
		} else if(!config.user) {
			this.log.error('user not set!')
			error = true
		} else if(!config.pass) {
			this.log.error('pass not set!')
			error = true
		} 
		
		return error
	}
}

type DahuaEventsConfig = {
    events:       Set<string>
    server:       CameraCredentials
}
