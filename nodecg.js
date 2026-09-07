/**
 * Minimal NodeCG 2.x replicant client over Engine.IO 4 / Socket.IO 5.
 *
 * Dependency-free: uses the global `WebSocket` and `fetch` available in the
 * Node 22 runtime that Companion runs modules under. Authenticates the socket
 * with a NodeCG `socketToken` passed in the handshake query string.
 *
 * Emits lifecycle callbacks (onConnect/onDisconnect/onError) and per-replicant
 * change callbacks. Handles automatic reconnection with backoff.
 */

export class NodeCGClient {
	constructor({ url, token, namespace, log }) {
		this.url = (url || '').replace(/\/+$/, '')
		this.token = token
		this.namespace = namespace
		this.log = log || (() => {})

		this.ws = null
		this.ackId = 0
		this.acks = new Map()
		this.reps = new Map() // name -> { value, revision, declared }
		this.listeners = new Map() // name -> [cb]
		this.wantConnected = false
		this.reconnectTimer = null
		this.reconnectDelay = 1000
		this.pingReplyTimer = null

		this.onConnect = null
		this.onDisconnect = null
		this.onError = null
	}

	// ---- public API ----------------------------------------------------------

	start() {
		this.wantConnected = true
		this._open()
	}

	stop() {
		this.wantConnected = false
		if (this.reconnectTimer) clearTimeout(this.reconnectTimer)
		this.reconnectTimer = null
		this._closeSocket()
	}

	on(name, cb) {
		if (!this.listeners.has(name)) this.listeners.set(name, [])
		this.listeners.get(name).push(cb)
	}

	get(name) {
		return this.reps.get(name)?.value ?? null
	}

	isConnected() {
		return !!this.ws && this.ws.readyState === 1
	}

	/** Declare (subscribe + read current value/revision), cached in this.reps. */
	async declare(name) {
		// Join the replicant's room first so we receive `replicant:operations`
		// broadcasts for it (this is what the NodeCG client does).
		if (!this.reps.get(name)?.joined) {
			await this._emitAck('joinRoom', `replicant:${this.namespace}:${name}`)
			const existing = this.reps.get(name)
			if (existing) existing.joined = true
		}
		const ack = await this._emitAck('replicant:declare', { name, namespace: this.namespace, opts: {} })
		const meta = Array.isArray(ack) ? ack[1] : ack
		const entry = {
			value: meta?.value ?? null,
			revision: meta?.revision ?? 0,
			schemaPath: `bundles/${this.namespace}/schemas/${name}.json`,
			declared: true,
			joined: true,
		}
		this.reps.set(name, entry)
		return entry
	}

	/** Overwrite a replicant's whole value. Re-reads head revision first. */
	async setValue(name, newValue) {
		const head = await this.declare(name) // fresh revision to avoid drift
		this._emit('replicant:proposeOperations', {
			name,
			namespace: this.namespace,
			operations: [{ path: '/', method: 'overwrite', args: { newValue } }],
			revision: head.revision,
			opts: { schemaPath: head.schemaPath, persistent: true, persistenceInterval: 100 },
		})
	}

	// ---- socket internals ----------------------------------------------------

	_open() {
		this._closeSocket()
		const wsUrl =
			this.url.replace(/^http/, 'ws') +
			'/socket.io/?EIO=4&transport=websocket&token=' +
			encodeURIComponent(this.token || '')

		let ws
		try {
			ws = new WebSocket(wsUrl)
		} catch (e) {
			this.onError?.(e)
			this._scheduleReconnect()
			return
		}
		this.ws = ws

		ws.onerror = (e) => {
			this.onError?.(new Error('WebSocket error: ' + (e?.message || 'unknown')))
		}
		ws.onclose = (ev) => {
			this._clearPingReply()
			this.onDisconnect?.(ev)
			if (this.wantConnected) this._scheduleReconnect()
		}
		ws.onmessage = (ev) => this._onMessage(String(ev.data))
	}

	_onMessage(d) {
		if (d === '2') {
			// engine.io ping -> pong
			this._safeSend('3')
			return
		}
		if (d[0] === '0') {
			// engine.io open -> connect to default namespace (auth already in query)
			this._safeSend('40')
			return
		}
		if (d.startsWith('40')) {
			// namespace connected
			this.reconnectDelay = 1000
			this.onConnect?.()
			return
		}
		if (d.startsWith('44')) {
			this.onError?.(new Error('Socket connect error: ' + d.slice(2)))
			return
		}
		const mAck = d.match(/^43(\d+)([\s\S]*)$/)
		if (mAck) {
			const cb = this.acks.get(Number(mAck[1]))
			this.acks.delete(Number(mAck[1]))
			try {
				cb?.(JSON.parse(mAck[2]))
			} catch {
				cb?.(null)
			}
			return
		}
		const mEv = d.match(/^42(\d*)(\[[\s\S]*)$/)
		if (mEv) {
			try {
				this._onEvent(JSON.parse(mEv[2]))
			} catch {
				/* ignore malformed */
			}
			return
		}
	}

	_onEvent([name, payload]) {
		if (name === 'replicant:operations') {
			if (payload.namespace !== this.namespace) return
			const entry = this.reps.get(payload.name)
			if (!entry) return
			for (const op of payload.operations) entry.value = applyOperation(entry.value, op)
			entry.revision = payload.revision
			this._notify(payload.name, entry.value)
		}
	}

	_notify(name, value) {
		for (const cb of this.listeners.get(name) || []) {
			try {
				cb(value)
			} catch (e) {
				this.log('debug', 'listener error: ' + e.message)
			}
		}
	}

	_emit(event, ...args) {
		this._safeSend('42' + JSON.stringify([event, ...args]))
	}

	_emitAck(event, ...args) {
		return new Promise((resolve, reject) => {
			if (!this.isConnected()) return reject(new Error('not connected'))
			const id = this.ackId++
			const timer = setTimeout(() => {
				this.acks.delete(id)
				reject(new Error('ack timeout for ' + event))
			}, 8000)
			this.acks.set(id, (v) => {
				clearTimeout(timer)
				resolve(v)
			})
			this._safeSend('42' + id + JSON.stringify([event, ...args]))
		})
	}

	_safeSend(data) {
		try {
			this.ws?.send(data)
		} catch (e) {
			this.log('debug', 'send failed: ' + e.message)
		}
	}

	_closeSocket() {
		if (this.ws) {
			this.ws.onopen = this.ws.onclose = this.ws.onerror = this.ws.onmessage = null
			try {
				this.ws.close()
			} catch {
				/* ignore */
			}
			this.ws = null
		}
		this._clearPingReply()
	}

	_clearPingReply() {
		if (this.pingReplyTimer) clearTimeout(this.pingReplyTimer)
		this.pingReplyTimer = null
	}

	_scheduleReconnect() {
		if (!this.wantConnected || this.reconnectTimer) return
		const delay = this.reconnectDelay
		this.reconnectDelay = Math.min(this.reconnectDelay * 2, 15000)
		this.reconnectTimer = setTimeout(() => {
			this.reconnectTimer = null
			if (this.wantConnected) this._open()
		}, delay)
	}
}

/**
 * Applies a NodeCG replicant operation to a value (JSON-pointer path + method).
 * Covers the full NodeCG operation set; unknown methods are ignored.
 */
export function applyOperation(root, op) {
	const { path, method, args } = op
	if (path === '/' && method === 'overwrite') return args.newValue

	const segs = path
		.split('/')
		.slice(1)
		.map((s) => s.replace(/~1/g, '/').replace(/~0/g, '~'))

	let parent = root
	for (let i = 0; i < segs.length - 1; i++) parent = parent?.[segs[i]]
	const key = segs[segs.length - 1]
	const target = segs.length ? parent?.[key] : root

	switch (method) {
		case 'overwrite':
			if (segs.length) parent[key] = args.newValue
			else return args.newValue
			break
		case 'add':
		case 'update':
			if (segs.length) parent[key] = args.newValue
			else if (args.prop !== undefined) root[args.prop] = args.newValue
			break
		case 'delete':
			if (segs.length && parent) delete parent[key]
			break
		case 'push':
			if (Array.isArray(target)) target.push(...args.args)
			break
		case 'unshift':
			if (Array.isArray(target)) target.unshift(...args.args)
			break
		case 'pop':
			if (Array.isArray(target)) target.pop()
			break
		case 'shift':
			if (Array.isArray(target)) target.shift()
			break
		case 'splice':
			if (Array.isArray(target)) target.splice(...args.args)
			break
		case 'reverse':
			if (Array.isArray(target)) target.reverse()
			break
		case 'sort':
			if (Array.isArray(target)) target.sort()
			break
		case 'copyWithin':
			if (Array.isArray(target)) target.copyWithin(...args.args)
			break
		case 'fill':
			if (Array.isArray(target)) target.fill(...args.args)
			break
		default:
			break
	}
	return root
}

/**
 * Best-effort programmatic login to obtain a fresh `socketToken`.
 * Mirrors the browser flow: GET /dashboard/ (seed session) -> POST
 * /login/local -> GET /dashboard/ (which sets the socketToken cookie).
 *
 * Note: against some deployments this only succeeds from a real browser; when
 * it fails, configure the socket token manually instead. Returns the token
 * string, or throws.
 */
export async function fetchSocketToken({ url, username, password }) {
	const base = (url || '').replace(/\/+$/, '')
	const jar = new Map()
	const store = (res) => {
		const cookies = res.headers.getSetCookie ? res.headers.getSetCookie() : []
		for (const c of cookies) {
			const [kv] = c.split(';')
			const i = kv.indexOf('=')
			if (i > 0) jar.set(kv.slice(0, i).trim(), kv.slice(i + 1).trim())
		}
	}
	const cookieHeader = () => [...jar.entries()].map(([k, v]) => `${k}=${v}`).join('; ')

	// 1. seed session
	store(await fetch(base + '/dashboard/', { headers: { Cookie: cookieHeader() }, redirect: 'manual' }))
	// 2. login
	store(
		await fetch(base + '/login/local', {
			method: 'POST',
			headers: { 'Content-Type': 'application/x-www-form-urlencoded', Cookie: cookieHeader() },
			body: new URLSearchParams({ username, password }).toString(),
			redirect: 'manual',
		}),
	)
	// 3. load dashboard -> issues socketToken cookie
	store(await fetch(base + '/dashboard/', { headers: { Cookie: cookieHeader() }, redirect: 'manual' }))

	const token = jar.get('socketToken')
	if (!token) throw new Error('Login did not yield a socketToken (check credentials, or set the token manually)')
	return token
}
