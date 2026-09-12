export interface RoomInfo {
	id: string
	name: string
	createdAt?: number | string
}

export interface SessionResponse {
	authenticated: boolean
}

export async function getSession(): Promise<boolean> {
	try {
		const res = await fetch('/api/session', {
			method: 'GET',
			credentials: 'same-origin',
		})
		if (!res.ok) return false
		const data = (await res.json()) as SessionResponse
		return Boolean(data?.authenticated)
	} catch {
		return false
	}
}

export async function loginWithToken(token: string): Promise<{ ok: boolean; error?: string }> {
	try {
		const res = await fetch('/api/session', {
			method: 'POST',
			headers: {
				'Content-Type': 'application/json',
			},
			body: JSON.stringify({ token }),
			credentials: 'same-origin',
		})

		if (res.ok) {
			return { ok: true }
		}

		if (res.status === 401) {
			return { ok: false, error: '口令错误，请重新输入' }
		}

		const text = await res.text().catch(() => '')
		return { ok: false, error: text || `验证失败 (${res.status})` }
	} catch (err: any) {
		return { ok: false, error: err?.message || '网络请求失败，请检查网络后重试' }
	}
}

export async function logoutSession(): Promise<boolean> {
	try {
		const res = await fetch('/api/session', {
			method: 'DELETE',
			credentials: 'same-origin',
		})
		return res.ok
	} catch {
		return false
	}
}

export async function getRooms(): Promise<RoomInfo[]> {
	const res = await fetch('/api/rooms', {
		method: 'GET',
		credentials: 'same-origin',
	})
	if (!res.ok) {
		throw new Error(`获取白板列表失败 (${res.status})`)
	}
	const data = (await res.json()) as { rooms?: RoomInfo[] }
	return data.rooms || []
}

export async function createRoom(name: string): Promise<RoomInfo> {
	const res = await fetch('/api/rooms', {
		method: 'POST',
		headers: {
			'Content-Type': 'application/json',
		},
		body: JSON.stringify({ name }),
		credentials: 'same-origin',
	})
	if (!res.ok) {
		const text = await res.text().catch(() => '')
		throw new Error(text || `创建白板失败 (${res.status})`)
	}
	return (await res.json()) as RoomInfo
}

export async function renameRoom(id: string, name: string): Promise<RoomInfo | void> {
	const res = await fetch(`/api/rooms/${encodeURIComponent(id)}`, {
		method: 'PATCH',
		headers: {
			'Content-Type': 'application/json',
		},
		body: JSON.stringify({ name }),
		credentials: 'same-origin',
	})
	if (!res.ok) {
		const text = await res.text().catch(() => '')
		throw new Error(text || `修改白板名称失败 (${res.status})`)
	}
	try {
		return (await res.json()) as RoomInfo
	} catch {
		return
	}
}
