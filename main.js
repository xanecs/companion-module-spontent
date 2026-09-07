import { InstanceBase, runEntrypoint, InstanceStatus, combineRgb } from '@companion-module/base'
import { NodeCGClient, fetchSocketToken } from './nodecg.js'
import { UpgradeScripts } from './upgrades.js'
import {
	TEAMS,
	sideToTeam,
	GRAPHICS,
	graphicChoices,
	graphicOnValue,
	isGraphicActive,
	isPlayerActive,
	findPlayer,
	squadPlayers,
	playerDisplayName,
} from './graphics.js'

// Replicants we read/track for the whole feature set.
const REPLICANTS = ['full', 'bug', 'lowerthird', 'match', 'teamsquad']

class SpontentInstance extends InstanceBase {
	async init(config) {
		this.config = config
		this.ncg = null
		this.lastRosterLen = -1

		this.setActionDefinitions(this.buildActions())
		this.setFeedbackDefinitions(this.buildFeedbacks())
		this.setVariableDefinitions([]) // filled once data arrives

		await this.connect()
	}

	async destroy() {
		this.ncg?.stop()
		this.ncg = null
	}

	async configUpdated(config) {
		this.config = config
		await this.connect()
	}

	getConfigFields() {
		return [
			{
				type: 'static-text',
				id: 'info',
				width: 12,
				label: 'About',
				value:
					'Controls the Spontent NodeCG volleyball graphics ("Stream" tab). ' +
					'Enter the base URL and a Socket Token. The token is the value of the ' +
					'`socketToken` cookie in your logged-in dashboard browser session ' +
					'(DevTools → Application → Cookies). Username/password login is attempted ' +
					'only if no token is set, and may not work depending on the server.',
			},
			{
				type: 'textinput',
				id: 'url',
				label: 'Base URL',
				width: 12,
				default: '',
				tooltip: 'e.g. https://93.d.vbl.spontent-gfx.de',
			},
			{
				type: 'textinput',
				id: 'token',
				label: 'Socket Token (recommended)',
				width: 12,
				default: '',
				tooltip: 'Value of the socketToken cookie from a logged-in dashboard session',
			},
			{ type: 'textinput', id: 'username', label: 'Username (optional login)', width: 6, default: '' },
			{ type: 'textinput', id: 'password', label: 'Password (optional login)', width: 6, default: '' },
		]
	}

	// ---- connection ----------------------------------------------------------

	async connect() {
		this.ncg?.stop()
		this.ncg = null

		const url = (this.config.url || '').trim()
		if (!url) {
			this.updateStatus(InstanceStatus.BadConfig, 'Base URL not set')
			return
		}

		this.updateStatus(InstanceStatus.Connecting)

		let token = (this.config.token || '').trim()
		if (!token) {
			if (this.config.username && this.config.password) {
				try {
					token = await fetchSocketToken({ url, username: this.config.username, password: this.config.password })
					this.log('info', 'Obtained socket token via login')
				} catch (e) {
					this.updateStatus(InstanceStatus.BadConfig, 'Login failed — set the Socket Token manually')
					this.log('error', 'Login failed: ' + e.message)
					return
				}
			} else {
				this.updateStatus(InstanceStatus.BadConfig, 'No Socket Token or credentials configured')
				return
			}
		}

		const ncg = new NodeCGClient({
			url,
			token,
			namespace: 'graphics',
			log: (level, msg) => this.log(level, msg),
		})
		this.ncg = ncg

		ncg.onError = (e) => this.log('debug', e.message)
		ncg.onDisconnect = () => this.updateStatus(InstanceStatus.Disconnected, 'Disconnected — reconnecting')
		ncg.onConnect = async () => {
			try {
				for (const name of REPLICANTS) {
					await ncg.declare(name)
					ncg.on(name, () => this.onReplicantChange(name))
				}
				this.updateStatus(InstanceStatus.Ok)
				this.updateVariables()
				this.checkFeedbacks('graphic_active', 'player_active')
			} catch (e) {
				this.updateStatus(InstanceStatus.ConnectionFailure, e.message)
				this.log('error', 'Setup after connect failed: ' + e.message)
			}
		}

		ncg.start()
	}

	onReplicantChange(name) {
		if (name === 'match' || name === 'teamsquad') this.updateVariables()
		this.checkFeedbacks('graphic_active', 'player_active')
	}

	// Snapshot of the graphic slot replicants for feedback matching.
	slotValues() {
		return {
			full: this.ncg?.get('full') ?? null,
			bug: this.ncg?.get('bug') ?? null,
			lowerthird: this.ncg?.get('lowerthird') ?? null,
		}
	}

	// ---- actions -------------------------------------------------------------

	buildActions() {
		const teamChoices = TEAMS.map((t) => ({ id: t.side, label: t.label }))
		return {
			graphic: {
				name: 'Graphic: Show / Hide / Toggle',
				options: [
					{ type: 'dropdown', id: 'graphic', label: 'Graphic', default: 'pre_game', choices: graphicChoices() },
					{
						type: 'dropdown',
						id: 'mode',
						label: 'Action',
						default: 'toggle',
						choices: [
							{ id: 'toggle', label: 'Toggle' },
							{ id: 'show', label: 'Show' },
							{ id: 'hide', label: 'Hide' },
						],
					},
				],
				callback: async (action) => {
					const id = action.options.graphic
					const g = GRAPHICS[id]
					if (!g || !this.ncg) return
					const active = isGraphicActive(id, this.slotValues())
					const mode = action.options.mode
					if (mode === 'show' || (mode === 'toggle' && !active)) {
						await this.ncg.setValue(g.rep, graphicOnValue(id))
					} else if (mode === 'hide' || (mode === 'toggle' && active)) {
						await this.ncg.setValue(g.rep, null)
					}
				},
			},

			player_lowerthird: {
				name: 'Player Lowerthird: Fire by shirt number',
				options: [
					{ type: 'dropdown', id: 'team', label: 'Team', default: 'home', choices: teamChoices },
					{
						type: 'textinput',
						id: 'number',
						label: 'Shirt number',
						default: '',
						useVariables: true,
						tooltip: 'The player jersey number (supports variables)',
					},
					{
						type: 'dropdown',
						id: 'mode',
						label: 'Action',
						default: 'show',
						choices: [
							{ id: 'show', label: 'Show' },
							{ id: 'hide', label: 'Hide' },
							{ id: 'toggle', label: 'Toggle' },
						],
					},
				],
				callback: async (action) => {
					if (!this.ncg) return
					const side = action.options.team
					const number = (await this.parseVariablesInString(String(action.options.number ?? ''))).trim()
					const mode = action.options.mode
					const active = isPlayerActive(this.ncg.get('lowerthird'), side, number)

					if (mode === 'hide' || (mode === 'toggle' && active)) {
						await this.ncg.setValue('lowerthird', null)
						return
					}
					// show / toggle-on
					const player = findPlayer(this.ncg.get('match'), this.ncg.get('teamsquad'), side, number)
					if (!player) {
						this.log('warn', `No player with number "${number}" found for ${side} team`)
						return
					}
					await this.ncg.setValue('lowerthird', {
						type: 'PLAYER',
						player,
						team: sideToTeam(side),
						startTime: Date.now(),
					})
				},
			},

			hide_slot: {
				name: 'Hide graphic slot',
				options: [
					{
						type: 'dropdown',
						id: 'slot',
						label: 'Slot',
						default: 'lowerthird',
						choices: [
							{ id: 'full', label: 'Full-screen graphic' },
							{ id: 'bug', label: 'Score bug' },
							{ id: 'lowerthird', label: 'Lowerthird' },
							{ id: 'all', label: 'All of the above' },
						],
					},
				],
				callback: async (action) => {
					if (!this.ncg) return
					const slot = action.options.slot
					const slots = slot === 'all' ? ['full', 'bug', 'lowerthird'] : [slot]
					for (const s of slots) await this.ncg.setValue(s, null)
				},
			},
		}
	}

	// ---- feedbacks -----------------------------------------------------------

	buildFeedbacks() {
		const teamChoices = TEAMS.map((t) => ({ id: t.side, label: t.label }))
		const active = combineRgb(0, 180, 60)
		const white = combineRgb(255, 255, 255)
		return {
			graphic_active: {
				type: 'boolean',
				name: 'Graphic is live',
				defaultStyle: { bgcolor: active, color: white },
				options: [
					{ type: 'dropdown', id: 'graphic', label: 'Graphic', default: 'pre_game', choices: graphicChoices() },
				],
				callback: (fb) => isGraphicActive(fb.options.graphic, this.slotValues()),
			},
			player_active: {
				type: 'boolean',
				name: 'Player Lowerthird is live',
				defaultStyle: { bgcolor: active, color: white },
				options: [
					{ type: 'dropdown', id: 'team', label: 'Team', default: 'home', choices: teamChoices },
					{
						type: 'textinput',
						id: 'number',
						label: 'Shirt number (empty = any)',
						default: '',
						useVariables: true,
					},
				],
				callback: async (fb) => {
					const number = (await this.parseVariablesInString(String(fb.options.number ?? ''))).trim()
					return isPlayerActive(this.ncg?.get('lowerthird'), fb.options.team, number)
				},
			},
		}
	}

	// ---- variables -----------------------------------------------------------

	updateVariables() {
		const match = this.ncg?.get('match')
		const squad = this.ncg?.get('teamsquad')

		const homePlayers = squadPlayers(squad, 'home')
		const awayPlayers = squadPlayers(squad, 'away')
		const maxLen = Math.max(homePlayers.length, awayPlayers.length)

		// (Re)define variables when the roster length changes.
		if (maxLen !== this.lastRosterLen) {
			this.lastRosterLen = maxLen
			const defs = [
				{ variableId: 'home_name', name: 'Home team name' },
				{ variableId: 'away_name', name: 'Away team name' },
				{ variableId: 'home_shortname', name: 'Home team short name' },
				{ variableId: 'away_shortname', name: 'Away team short name' },
				{ variableId: 'home_count', name: 'Home roster size' },
				{ variableId: 'away_count', name: 'Away roster size' },
			]
			for (const side of ['home', 'away']) {
				for (let i = 0; i < maxLen; i++) {
					defs.push({ variableId: `${side}_${i}_number`, name: `${side} #${i} jersey number` })
					defs.push({ variableId: `${side}_${i}_name`, name: `${side} #${i} full name` })
					defs.push({ variableId: `${side}_${i}_firstname`, name: `${side} #${i} first name` })
					defs.push({ variableId: `${side}_${i}_lastname`, name: `${side} #${i} last name` })
				}
			}
			this.setVariableDefinitions(defs)
		}

		const values = {
			home_name: match?.team1?.name ?? '',
			away_name: match?.team2?.name ?? '',
			home_shortname: match?.team1?.shortName ?? '',
			away_shortname: match?.team2?.shortName ?? '',
			home_count: homePlayers.length,
			away_count: awayPlayers.length,
		}
		const fill = (side, players) => {
			for (let i = 0; i < maxLen; i++) {
				const p = players[i]
				values[`${side}_${i}_number`] = p ? String(p.jerseyNumber ?? '') : ''
				values[`${side}_${i}_name`] = p ? playerDisplayName(p) : ''
				values[`${side}_${i}_firstname`] = p ? (p.firstName ?? '') : ''
				values[`${side}_${i}_lastname`] = p ? (p.lastName ?? '') : ''
			}
		}
		fill('home', homePlayers)
		fill('away', awayPlayers)
		this.setVariableValues(values)
	}
}

runEntrypoint(SpontentInstance, UpgradeScripts)
