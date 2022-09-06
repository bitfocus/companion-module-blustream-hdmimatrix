// BLUESTREAM HDMI MATRIX EXTENDER

let tcp = require('../../tcp')
let instance_skel = require('../../instance_skel')

var debug
var log

class instance extends instance_skel {
	constructor(system, id, config) {
		super(system, id, config)

		this.CHOICES_INPUTS = []
		this.CHOICES_OUTPUTS = []
		this.CHOICES_POWER = [
			{ id: 'PON', label: 'ON' },
			{ id: 'POFF', label: 'OFF' },
		]
		this.CHOICES_STATE = [
			{ id: 'enable', label: 'ENABLE / ON / YES' },
			{ id: 'disable', label: 'DISABLE / OFF  / NO' },
			{ id: 'toggle', label: 'TOGGLE' },
		]
		this.pollMixerTimer = undefined
		this.selectedInput = 1
		this.outputRoute = {}
		this.outputHDMI = {}
		this.outputCAT = {}
		this.outputMUTE = {}
	}

	destroy() {
		if (this.socket !== undefined) {
			this.socket.destroy()
		}

		if (this.pollMixerTimer !== undefined) {
			clearInterval(this.pollMixerTimer)
			delete this.pollMixerTimer
		}

		debug('destroy', this.id)
	}

	init() {
		debug = this.debug
		log = this.log
		this.updateConfig(this.config)
	}

	updateConfig(config) {
		// polling is running and polling may have been de-selected by config change
		if (this.pollMixerTimer !== undefined) {
			clearInterval(this.pollMixerTimer)
			delete this.pollMixerTimer
		}
		this.config = config

		this.config.polling_interval = this.config.polling_interval !== undefined ? this.config.polling_interval : 750
		this.config.port = this.config.port !== undefined ? this.config.port : 23

		this.initArrays(this.config.inChannels, this.config.outChannels)
		this.initActions()
		this.initFeedbacks()
		this.initVariables()
		this.init_tcp()
		this.initPolling()
		this.initPresets()
	}

	init_tcp() {
		if (this.socket !== undefined) {
			this.socket.destroy()
			delete this.socket
		}

		if (this.config.host) {
			this.socket = new tcp(this.config.host, this.config.port)

			this.socket.on('status_change', (status, message) => {
				this.status(status, message)
			})

			this.socket.on('error', (err) => {
				debug('Network error', err)
				this.log('error', 'Network error: ' + err.message)
			})

			this.socket.on('connect', () => {
				debug('Connected')
			})

			this.socket.on('data', (receivebuffer) => {
				this.processResponse(receivebuffer)
			})
		}
	}
	/*
	example responses from switch:
						
	Matrix-4x4> status

	================================================================
				HDMI/HDBT Matrix-4x4 Status
				FW Version: 1.17

	Power   IR      Key     DBG     Beep    LCD
	ON      ON      ON      OFF     OFF     ON

	Input   Edid         HDMIcon
	01      DEFAULT_00   ON
	02      DEFAULT_00   ON
	03      DEFAULT_00   OFF
	04      DEFAULT_00   OFF

	Output  FromIn       HDMI/HDBTcon   OutputEn    POH
	01      01           OFF/OFF        Yes         ON
	02      01           ON /OFF        Yes         ON
	03      01           OFF/ON         Yes         ON
	04      02           OFF/OFF        Yes         ON

	Audio   Volume  Mute
	01      25      OFF
	02      25      OFF
	03      25      OFF
	04      25      OFF

	DHCP            IP              Gateway         SubnetMask
	OFF             192.168.001.020 192.168.001.254 255.255.255.000

	Telnet          MAC
	0023            4A:70:4B:BA:C9:9B
	================================================================


	Matrix-4x4> OUT01FR01
	[SUCCESS]Set output 01 connect from input 01.

Matrix-4x4>					
					
	*/
	processResponse(receivebuffer) {
		let capture = true
		let channel = 0
		let localTokens = ''
		let localLine = ''
		let lookahead = 1
		let index = 0
		if (this.config.log_responses) {
			this.log('info', 'Response: ' + receivebuffer)
		}
		if (this.config.polled_data) {
			// convert buffer to string and then into lines, removing blank lines
			let lines = receivebuffer
				.toString('utf8')
				.split(/[\r?\n]+/)
				.filter((element) => element)
			if (lines.length > 0) {
				for (index = 0; index < lines.length; index++) {
					if (lines[index].length > 0) {
						let tokens = lines[index].split(/[\t ]+/)
						if (this.config.log_tokens) {
							this.log('info', 'Tokens: ' + tokens)
						}
						capture = true
						lookahead = 1
						// switch on left slice value of line
						switch (tokens[0]) {
							case '[SUCCESS]Set':
								// no action, picked up in status
								break
							case 'Output':
								do { // now look ahead for line items until a blank line
									// remove odd space in hdmi status and split into tokens. Avoid error on final blank line in lookahead (some uncertainty over empty/undefined string with blank line)
									localLine = lines[index + lookahead]
									if (localLine !== undefined) {
										localTokens = localLine?.replace(/[\s]+\//, '/').split(/[\t ]+/)
										if (this.config.log_tokens) {
											this.log('info', 'Local Tokens: ' + localTokens)
										}
										channel = parseInt(localTokens[0])
										if (!isNaN(channel)) {
											// is a number
											this.updateRoute(channel, parseInt(localTokens[1]))
											this.updateHDMI(channel, localTokens[3] == 'No' ? 'disable' : 'enable')
											this.updateCAT(channel, localTokens[4] == 'OFF' ? 'disable' : 'enable')
										} else {
											capture = false
										}
									} else {
										capture = false
									}
									lookahead++
								} while (capture)
								index += lookahead - 1 // to avoid skipping line when for loop increments
								break
							case 'Audio':
								do { // now look ahead for line items until a blank line
									localLine = lines[index + lookahead]
									if (localLine !== undefined) {
										localTokens = localLine.split(/[\t ]+/)
										if (this.config.log_tokens) {
											this.log('info', 'Local Tokens: ' + localTokens)
										}
										channel = parseInt(localTokens[0])
										if (!isNaN(channel)) {
											// is a number
											// explicit token check to protect against occasional odd responses from the unit
											if (localTokens[2] == 'OFF') {
												this.updateMUTE(channel, 'disable')
											}
											if (localTokens[2] == 'ON') {
												this.updateMUTE(channel, 'enable')
											}
										} else {
											capture = false
										}
									} else {
										capture = false
									}
									lookahead++
								} while (capture)
								index += lookahead - 1 // to avoid skipping line when for loop increments
								break
						}
					}
				}
				this.checkFeedbacks()
			}
		}
	}

	sendCommmand(cmd) {
		if (cmd !== undefined) {
			if (this.socket !== undefined && this.socket.connected) {
				this.socket.send(cmd + '\r\n')
			} else {
				debug('Socket not connected :(')
			}
		}
	}

	initPolling() {
		// read switch state, possible changes using controls on the unit or web interface, 0 for all channels
		if (this.pollMixerTimer === undefined) {
			this.pollMixerTimer = setInterval(() => {
				this.sendCommmand('STATUS')
			}, this.config.poll_interval)
		}
	}

	updateMatrixVariables() {
		this.CHOICES_INPUTS.forEach((input) => {
			let list = ''
			for (let key in this.outputRoute) {
				if (this.outputRoute[key] == input.id) {
					list += key + '.'
				}
			}
			this.setVariable(`input_route${input.id}`, list)
		})
	}

	updateRoute(output, input) {
		this.outputRoute[output] = input
		this.setVariable(`output_route${output}`, input)
		this.updateMatrixVariables()
	}

	updateCAT(output, stateToggle) {
		if (stateToggle == 'toggle') {
			this.outputCAT[output] == 'disable' ? (stateToggle = 'enable') : (stateToggle = 'disable')
		}
		this.outputCAT[output] = stateToggle
		return stateToggle == 'disable' ? 'OFF' : 'ON'
	}
	updateHDMI(output, stateToggle) {
		if (stateToggle == 'toggle') {
			this.outputHDMI[output] == 'disable' ? (stateToggle = 'enable') : (stateToggle = 'disable')
		}
		this.outputHDMI[output] = stateToggle
		return stateToggle == 'disable' ? 'OFF' : 'ON'
	}
	updateMUTE(output, stateToggle) {
		if (stateToggle == 'toggle') {
			this.outputMUTE[output] == 'disable' ? (stateToggle = 'enable') : (stateToggle = 'disable')
		}
		this.outputMUTE[output] = stateToggle
		return stateToggle == 'disable' ? 'OFF' : 'ON'
	}

	initArrays(inChannels, outChannels) {
		this.CHOICES_INPUTS = []
		this.CHOICES_OUTPUTS = []
		this.outputRoute = {}
		this.outputCAT = {}
		this.outputHDMI = {}
		this.outputMUTE = {}
		if (inChannels > 0) {
			for (let i = 1; i <= inChannels; i++) {
				let channelObj = {}
				channelObj.id = i
				channelObj.label = i
				this.CHOICES_INPUTS.push(channelObj)
			}
		}
		if (outChannels > 0) {
			for (let i = 1; i <= outChannels; i++) {
				let channelObj = {}
				channelObj.id = i
				channelObj.label = i
				this.CHOICES_OUTPUTS.push(channelObj)
				this.outputRoute[i] = i
				this.outputCAT[i] = 'enable'
				this.outputHDMI[i] = 'enable'
				this.outputMUTE[i] = 'enable'
			}
		}
	}

	initVariables() {
		let variables = []
		this.CHOICES_INPUTS.forEach((item) => {
			variables.push({
				label: `Input ${item.id}`,
				name: `input_route${item.id}`,
			})
		})
		this.CHOICES_OUTPUTS.forEach((item) => {
			variables.push({
				label: `Output ${item.id}`,
				name: `output_route${item.id}`,
			})
		})
		this.setVariableDefinitions(variables)
		this.CHOICES_OUTPUTS.forEach((output) => {
			this.setVariable(`output_route${output.id}`, this.outputRoute[output.id])
		})
		this.updateMatrixVariables()
	}

	config_fields() {
		return [
			{
				type: 'text',
				id: 'info',
				width: 12,
				label: 'Information',
				value: 'This module will connect to a BLUESTREAM HDMI MATRIX',
			},
			{
				type: 'textinput',
				id: 'host',
				label: 'IP Address',
				width: 6,
				default: '192.168.0.3',
				regex: this.REGEX_IP,
			},
			{
				type: 'textinput',
				id: 'port',
				label: 'IP Port',
				width: 6,
				default: '23',
				regex: this.REGEX_PORT,
			},
			{
				type: 'dropdown',
				id: 'outChannels',
				label: 'Number of output channels',
				default: '4',
				choices: [
					{ id: '2', label: '2' },
					{ id: '4', label: '4' },
					{ id: '6', label: '6' },
					{ id: '8', label: '8' },
					{ id: '16', label: '16' },
				],
			},
			{
				type: 'dropdown',
				id: 'inChannels',
				label: 'Number of input channels',
				default: '4',
				choices: [
					{ id: '4', label: '4' },
					{ id: '6', label: '6' },
					{ id: '8', label: '8' },
					{ id: '16', label: '16' },
				],
			},
			{
				type: 'number',
				id: 'poll_interval',
				label: 'Polling Interval (ms)',
				min: 300,
				max: 30000,
				default: 1000,
				width: 8,
			},
			{
				type: 'checkbox',
				id: 'polled_data',
				label: 'Use polled data from unit    :',
				default: true,
				width: 8,
			},
			{
				type: 'checkbox',
				id: 'log_responses',
				label: 'Log returned data    :',
				default: false,
				width: 8,
			},
			{
				type: 'checkbox',
				id: 'log_tokens',
				label: 'Log token data    :',
				default: false,
				width: 8,
			},
		]
	}

	initActions() {
		let actions = {
			select_input: {
				label: 'Select Input',
				options: [
					{
						type: 'dropdown',
						label: 'Input Port',
						id: 'input',
						default: '1',
						choices: this.CHOICES_INPUTS,
					},
				],
			},
			switch_output: {
				label: 'Switch Output',
				options: [
					{
						type: 'dropdown',
						label: 'Output Port',
						id: 'output',
						default: '1',
						choices: this.CHOICES_OUTPUTS,
					},
				],
			},
			input_output: {
				label: 'Input to Output',
				options: [
					{
						type: 'dropdown',
						label: 'Output Port',
						id: 'output',
						default: '1',
						choices: this.CHOICES_OUTPUTS,
					},
					{
						type: 'dropdown',
						label: 'Input Port',
						id: 'input',
						default: '1',
						choices: this.CHOICES_INPUTS,
					},
				],
			},
			cat_switch: {
				label: 'Enable/Disable CAT output',
				options: [
					{
						type: 'dropdown',
						id: 'output',
						default: '1',
						choices: this.CHOICES_OUTPUTS,
					},
					{
						type: 'dropdown',
						label: 'Enable / Disable / Toggle',
						id: 'stateToggle',
						default: 'on',
						choices: this.CHOICES_STATE,
					},
				],
			},
			hdmi_switch: {
				label: 'Enable/Disable HDMI output',
				options: [
					{
						type: 'dropdown',
						id: 'output',
						default: '1',
						choices: this.CHOICES_OUTPUTS,
					},
					{
						type: 'dropdown',
						label: 'Enable / Disable / Toggle',
						id: 'stateToggle',
						default: 'on',
						choices: this.CHOICES_STATE,
					},
				],
			},
			mute_output: {
				label: 'Mute output',
				options: [
					{
						type: 'dropdown',
						id: 'output',
						default: '1',
						choices: this.CHOICES_OUTPUTS,
					},
					{
						type: 'dropdown',
						label: 'On / Off / Toggle',
						id: 'stateToggle',
						default: 'on',
						choices: this.CHOICES_STATE,
					},
				],
			},
			power: {
				label: 'Power control',
				options: [
					{
						type: 'dropdown',
						label: 'Power control',
						id: 'power',
						default: 'PON',
						choices: this.CHOICES_POWER,
					},
				],
			},
		}
		this.setActions(actions)
	}

	action(action) {
		let options = action.options
		switch (action.action) {
			case 'select_input':
				this.selectedInput = options.input
				break
			case 'switch_output':
				this.sendCommmand(
					'OUT' + options.output.toString().padStart(2, '0') + 'FR' + this.selectedInput.toString().padStart(2, '0')
				)
				this.updateRoute(options.output, this.selectedInput)
				break
			case 'input_output':
				this.sendCommmand(
					'OUT' + options.output.toString().padStart(2, '0') + 'FR' + options.input.toString().padStart(2, '0')
				)
				this.updateRoute(options.output, options.input)
				break
			case 'cat_switch':
				this.sendCommmand(
					'POH' + options.output.toString().padStart(2, '0') + this.updateCAT(options.output, options.stateToggle)
				)
				break
			case 'hdmi_switch':
				this.sendCommmand(
					'OUT' + options.output.toString().padStart(2, '0') + this.updateHDMI(options.output, options.stateToggle)
				)
				break
			case 'mute_output':
				this.sendCommmand(
					'MUTE' +
						this.updateMUTE(options.output, options.stateToggle) +
						'TX' +
						options.output.toString().padStart(2, '0')
				)
				break
			case 'power':
				this.sendCommmand(options.power)
				break
		} // note that internal status values are set immediately for feedback responsiveness and will be updated again when the unit responds to polling (hopefully with the same value!)
		this.checkFeedbacks()
	}

	initFeedbacks() {
		let feedbacks = {}

		feedbacks['selected'] = {
			type: 'boolean',
			label: 'Status for input',
			description: 'Show feedback selected input',
			options: [
				{
					type: 'dropdown',
					label: 'Input',
					id: 'input',
					default: '1',
					choices: this.CHOICES_INPUTS,
				},
			],
			style: {
				color: this.rgb(0, 0, 0),
				bgcolor: this.rgb(255, 0, 0),
			},
			callback: (feedback, bank) => {
				let opt = feedback.options
				if (this.selectedInput == opt.input) {
					return true
				} else {
					return false
				}
			},
		}
		feedbacks['output'] = {
			type: 'boolean',
			label: 'Status for output',
			description: 'Show feedback selected output',
			options: [
				{
					type: 'dropdown',
					label: 'Output',
					id: 'output',
					default: '1',
					choices: this.CHOICES_OUTPUTS,
				},
			],
			style: {
				color: this.rgb(0, 0, 0),
				bgcolor: this.rgb(0, 255, 0),
			},
			callback: (feedback, bank) => {
				let opt = feedback.options
				if (this.outputRoute[opt.output] == this.selectedInput) {
					return true
				} else {
					return false
				}
			},
		}
		feedbacks['stateHDMI'] = {
			type: 'boolean',
			label: 'State for HDMI output',
			description: 'Enable state for HDMI output',
			options: [
				{
					type: 'dropdown',
					label: 'Output',
					id: 'output',
					default: '1',
					choices: this.CHOICES_OUTPUTS,
				},
			],
			style: {
				color: this.rgb(0, 0, 0),
				bgcolor: this.rgb(255, 0, 0),
			},
			callback: (feedback, bank) => {
				let opt = feedback.options
				if (this.outputHDMI[opt.output] == 'disable') {
					return true
				} else {
					return false
				}
			},
		}
		feedbacks['stateCAT'] = {
			type: 'boolean',
			label: 'State for CAT output',
			description: 'Enable state for CAT output',
			options: [
				{
					type: 'dropdown',
					label: 'Output',
					id: 'output',
					default: '1',
					choices: this.CHOICES_OUTPUTS,
				},
			],
			style: {
				color: this.rgb(0, 0, 0),
				bgcolor: this.rgb(255, 0, 0),
			},
			callback: (feedback, bank) => {
				let opt = feedback.options
				if (this.outputCAT[opt.output] == 'disable') {
					return true
				} else {
					return false
				}
			},
		}
		feedbacks['stateMUTE'] = {
			type: 'boolean',
			label: 'State for output MUTE',
			description: 'Enable state for output MUTE',
			options: [
				{
					type: 'dropdown',
					label: 'Output',
					id: 'output',
					default: '1',
					choices: this.CHOICES_OUTPUTS,
				},
			],
			style: {
				color: this.rgb(0, 0, 0),
				bgcolor: this.rgb(255, 0, 0),
			},
			callback: (feedback, bank) => {
				let opt = feedback.options
				if (this.outputMUTE[opt.output] == 'enable') {
					return true
				} else {
					return false
				}
			},
		}
		this.setFeedbackDefinitions(feedbacks)
		this.checkFeedbacks()
	}
	initPresets() {
		let presets = []

		const aSelectPreset = (input) => {
			return {
				category: 'Select Input',
				label: 'Select',
				bank: {
					style: 'text',
					text: `In ${input}\\n> $(${this.config.label}:input_route${input})`,
					size: 'auto',
					color: this.rgb(255, 255, 255),
					bgcolor: this.rgb(0, 0, 0),
				},
				actions: [
					{
						action: 'select_input',
						options: {
							input: input,
						},
					},
				],
				feedbacks: [
					{
						type: 'selected',
						options: {
							input: input,
						},
						style: {
							color: this.rgb(0, 0, 0),
							bgcolor: this.rgb(255, 0, 0),
						},
					},
				],
			}
		}
		const aSwitchPreset = (output) => {
			return {
				category: 'Switch Output',
				label: 'Switch',
				bank: {
					style: 'text',
					text: `Out ${output}\\n< $(${this.config.label}:output_route${output})`,
					size: 'auto',
					color: this.rgb(255, 255, 255),
					bgcolor: this.rgb(0, 0, 0),
				},
				actions: [
					{
						action: 'switch_output',
						options: {
							output: output,
						},
					},
				],
				feedbacks: [
					{
						type: 'output',
						options: {
							output: output,
						},
						style: {
							color: this.rgb(0, 0, 0),
							bgcolor: this.rgb(0, 255, 0),
						},
					},
				],
			}
		}
		const aCATPreset = (output) => {
			return {
				category: 'stateCAT',
				label: 'State of CAT output',
				bank: {
					style: 'text',
					text: `CAT Out ${output}`,
					size: 'auto',
					color: this.rgb(0, 0, 0),
					bgcolor: this.rgb(0, 255, 0),
				},
				actions: [
					{
						action: 'cat_switch',
						options: {
							output: output,
							stateToggle: 'toggle',
						},
					},
				],
				feedbacks: [
					{
						type: 'stateCAT',
						options: {
							output: output,
						},
						style: {
							color: this.rgb(0, 0, 0),
							bgcolor: this.rgb(255, 0, 0),
						},
					},
				],
			}
		}

		const aHDMIPreset = (output) => {
			return {
				category: 'stateHDMI',
				label: 'State of HDMI output',
				bank: {
					style: 'text',
					text: `HDMI Out ${output}`,
					size: 'auto',
					color: this.rgb(0, 0, 0),
					bgcolor: this.rgb(0, 255, 0),
				},
				actions: [
					{
						action: 'hdmi_switch',
						options: {
							output: output,
							stateToggle: 'toggle',
						},
					},
				],
				feedbacks: [
					{
						type: 'stateHDMI',
						options: {
							output: output,
						},
						style: {
							color: this.rgb(0, 0, 0),
							bgcolor: this.rgb(255, 0, 0),
						},
					},
				],
			}
		}

		const aMUTEPreset = (output) => {
			return {
				category: 'stateMUTE',
				label: 'State of output MUTE',
				bank: {
					style: 'text',
					text: `Mute output ${output}`,
					size: 'auto',
					color: this.rgb(0, 0, 0),
					bgcolor: this.rgb(0, 255, 0),
				},
				actions: [
					{
						action: 'mute_output',
						options: {
							output: output,
							stateToggle: 'toggle',
						},
					},
				],
				feedbacks: [
					{
						type: 'stateMUTE',
						options: {
							output: output,
						},
						style: {
							color: this.rgb(0, 0, 0),
							bgcolor: this.rgb(255, 0, 0),
						},
					},
				],
			}
		}

		this.CHOICES_INPUTS.forEach((input) => {
			presets.push(aSelectPreset(input.id))
		})
		this.CHOICES_OUTPUTS.forEach((output) => {
			presets.push(aSwitchPreset(output.id))
		})
		this.CHOICES_OUTPUTS.forEach((output) => {
			presets.push(aCATPreset(output.id))
		})
		this.CHOICES_OUTPUTS.forEach((output) => {
			presets.push(aHDMIPreset(output.id))
		})
		this.CHOICES_OUTPUTS.forEach((output) => {
			presets.push(aMUTEPreset(output.id))
		})

		presets.push({
			category: 'In to Out',
			label: 'In to Out',
			bank: {
				style: 'text',
				text: 'In to Out',
				size: 'auto',
				color: this.rgb(255, 255, 255),
				bgcolor: this.rgb(0, 0, 0),
			},
			actions: [
				{
					action: 'input_output',
					options: {
						input: '1',
						output: '1',
						select: false,
					},
				},
			],
		})

		presets.push({
			category: 'Power',
			label: 'Power',
			bank: {
				style: 'text',
				text: 'Power Off',
				size: 'auto',
				color: this.rgb(255, 255, 255),
				bgcolor: this.rgb(0, 0, 0),
			},
			actions: [
				{
					action: 'power',
					options: {
						power: 'POFF',
					},
				},
			],
		})

		presets.push({
			category: 'Power',
			label: 'Power',
			bank: {
				style: 'text',
				text: 'Power On',
				size: 'auto',
				color: this.rgb(255, 255, 255),
				bgcolor: this.rgb(0, 0, 0),
			},
			actions: [
				{
					action: 'power',
					options: {
						power: 'PON',
					},
				},
			],
		})

		this.setPresetDefinitions(presets)
	}
}
exports = module.exports = instance
