/**
 * Data model for the Spontent volleyball graphics bundle, derived from the
 * "Stream" dashboard tab. Maps friendly graphic ids to the NodeCG replicant
 * writes that show/hide them, and provides helpers for feedback matching and
 * roster access.
 *
 * Replicants involved:
 *   full        - single full-screen graphic slot (mutually exclusive)
 *   bug         - the score bug overlay
 *   lowerthird  - the lower-third slot (score / player / official)
 *   match       - current match incl. team1/team2 (names + full player objects)
 *   teamsquad   - the match-day squad per team (what the dashboard lists)
 *
 * "Off" for any slot is an overwrite to null.
 * team1 == Home, team2 == Away.
 */

export const TEAMS = [
	{ id: 'team1', side: 'home', label: 'Home (Team 1)' },
	{ id: 'team2', side: 'away', label: 'Away (Team 2)' },
]

export const sideToTeam = (side) => (side === 'away' ? 'team2' : 'team1')

/**
 * Full-screen / overlay graphics that map to a single replicant value.
 * `perTeam` graphics additionally carry a `team` field in the value.
 */
export const GRAPHICS = {
	pre_game: { rep: 'full', type: 'PREGAME', label: 'Pre Game' },
	tabelle: { rep: 'full', type: 'RANKING', label: 'Tabelle (Ranking)' },
	referees: { rep: 'full', type: 'REFEREES', label: 'Referees' },
	kaderliste_home: { rep: 'full', type: 'TEAM', team: 'team1', label: 'Kaderliste (Home)' },
	kaderliste_away: { rep: 'full', type: 'TEAM', team: 'team2', label: 'Kaderliste (Away)' },
	starting_six_home: { rep: 'full', type: 'STARTING_SIX', team: 'team1', label: 'Starting Six (Home)' },
	starting_six_away: { rep: 'full', type: 'STARTING_SIX', team: 'team2', label: 'Starting Six (Away)' },
	score_bug: { rep: 'bug', type: 'SCORE', label: 'Score Bug' },
	score_lowerthird: { rep: 'lowerthird', type: 'SCORE', label: 'Score Lowerthird' },
}

export const graphicChoices = () => Object.entries(GRAPHICS).map(([id, g]) => ({ id, label: g.label }))

/** Build the replicant value that turns a graphic on. */
export function graphicOnValue(id) {
	const g = GRAPHICS[id]
	if (!g) return null
	const value = { type: g.type, startTime: Date.now() }
	if (g.team) value.team = g.team
	return value
}

/** Is graphic `id` currently live, given the current replicant values? */
export function isGraphicActive(id, values) {
	const g = GRAPHICS[id]
	if (!g) return false
	const v = values[g.rep]
	if (!v || v.type !== g.type) return false
	if (g.team) return v.team === g.team
	return true
}

/** Is a player lower-third for the given team/number currently live? */
export function isPlayerActive(lowerthird, side, number) {
	if (!lowerthird || lowerthird.type !== 'PLAYER') return false
	const team = sideToTeam(side)
	if (lowerthird.team !== team) return false
	if (number === undefined || number === '' || number === null) return true // "any player of this team"
	return String(lowerthird.player?.jerseyNumber) === String(number)
}

/**
 * Find the full player object (as the graphic expects it) for a shirt number.
 * Prefers the rich `match` roster; falls back to the `teamsquad` entry.
 */
export function findPlayer(match, teamsquad, side, number) {
	const team = sideToTeam(side)
	const num = String(number).trim()
	const fromMatch = match?.[team]?.players?.find((p) => String(p.jerseyNumber) === num)
	if (fromMatch) return fromMatch
	const sq = teamsquad?.[team]?.players?.find((p) => String(p.jerseyNumber) === num)
	if (!sq) return null
	// Best-effort shape if the player is only present in the squad replicant.
	return {
		id: sq.uuid,
		jerseyNumber: sq.jerseyNumber,
		firstName: sq.firstName,
		lastName: sq.lastName,
		name: `${sq.lastName}, ${sq.firstName}`,
		position: sq.position,
		portraitPhoto: sq.portraitPhoto,
	}
}

/** Sorted (by jersey number) squad player list for a team side. */
export function squadPlayers(teamsquad, side) {
	const team = sideToTeam(side)
	const players = teamsquad?.[team]?.players || []
	return [...players].sort((a, b) => (Number(a.jerseyNumber) || 0) - (Number(b.jerseyNumber) || 0))
}

export const playerDisplayName = (p) => `${p.firstName ?? ''} ${p.lastName ?? ''}`.trim()
