import { FormEvent, useEffect, useState } from 'react'
import { createRoom, getRooms, RoomInfo } from '../api'

interface WorkspaceListProps {
	onSelectRoom: (roomId: string) => void
	onLogout: () => void
}

export function WorkspaceList({ onSelectRoom, onLogout }: WorkspaceListProps) {
	const [rooms, setRooms] = useState<RoomInfo[]>([])
	const [loading, setLoading] = useState(true)
	const [error, setError] = useState<string | null>(null)
	const [newRoomName, setNewRoomName] = useState('')
	const [creating, setCreating] = useState(false)
	const [createError, setCreateError] = useState<string | null>(null)

	const loadRooms = async () => {
		setLoading(true)
		setError(null)
		try {
			const list = await getRooms()
			setRooms(list)
		} catch (err: any) {
			setError(err?.message || '加载白板列表失败')
		} finally {
			setLoading(false)
		}
	}

	useEffect(() => {
		loadRooms()
	}, [])

	const handleCreateRoom = async (e: FormEvent) => {
		e.preventDefault()
		const name = newRoomName.trim()
		if (!name) return

		setCreating(true)
		setCreateError(null)
		try {
			const created = await createRoom(name)
			setNewRoomName('')
			onSelectRoom(created.id)
		} catch (err: any) {
			setCreateError(err?.message || '创建失败，请重试')
		} finally {
			setCreating(false)
		}
	}

	const formatDate = (val?: number | string) => {
		if (!val) return ''
		try {
			const d = new Date(val)
			if (isNaN(d.getTime())) return ''
			return d.toLocaleDateString('zh-CN', {
				month: '2-digit',
				day: '2-digit',
				hour: '2-digit',
				minute: '2-digit',
			})
		} catch {
			return ''
		}
	}

	return (
		<div className="workspace-container">
			<header className="workspace-header">
				<div className="workspace-header-inner">
					<div className="workspace-brand">
						<svg
							className="workspace-brand-icon"
							viewBox="0 0 24 24"
							fill="none"
							stroke="currentColor"
							strokeWidth="2"
							strokeLinecap="round"
							strokeLinejoin="round"
						>
							<path d="M12 19l7-7 3 3-7 7-3-3z" />
							<path d="M18 13l-1.5-7.5L2 2l3.5 14.5L13 18l5-5z" />
							<path d="M2 2l7.586 7.586" />
							<circle cx="11" cy="11" r="2" />
						</svg>
						<h1 className="workspace-brand-title">白板工作区</h1>
					</div>
					<button type="button" className="workspace-logout-btn" onClick={onLogout}>
						退出登录
					</button>
				</div>
			</header>

			<main className="workspace-main">
				<section className="workspace-create-card">
					<form onSubmit={handleCreateRoom} className="workspace-create-form">
						<input
							type="text"
							className="workspace-create-input"
							placeholder="输入新白板名称..."
							value={newRoomName}
							onChange={(e) => {
								setNewRoomName(e.target.value)
								if (createError) setCreateError(null)
							}}
							disabled={creating}
						/>
						<button
							type="submit"
							className="workspace-create-btn"
							disabled={creating || !newRoomName.trim()}
						>
							{creating ? '创建中...' : '新建白板'}
						</button>
					</form>
					{createError && <p className="workspace-field-error">{createError}</p>}
				</section>

				<section className="workspace-rooms-section">
					<div className="workspace-section-header">
						<h2 className="workspace-section-title">我的白板</h2>
						<button
							type="button"
							className="workspace-refresh-btn"
							onClick={loadRooms}
							disabled={loading}
							title="刷新列表"
						>
							刷新
						</button>
					</div>

					{loading && (
						<div className="workspace-state-box">
							<div className="workspace-spinner" />
							<span>正在加载白板...</span>
						</div>
					)}

					{error && !loading && (
						<div className="workspace-state-box workspace-error-box">
							<span>{error}</span>
							<button type="button" className="workspace-retry-btn" onClick={loadRooms}>
								重试
							</button>
						</div>
					)}

					{!loading && !error && rooms.length === 0 && (
						<div className="workspace-state-box">
							<span>暂无白板，可在上方创建新白板</span>
						</div>
					)}

					{!loading && !error && rooms.length > 0 && (
						<div className="workspace-grid">
							{rooms.map((room) => (
								<div
									key={room.id}
									className="workspace-card"
									onClick={() => onSelectRoom(room.id)}
									role="button"
									tabIndex={0}
									onKeyDown={(e) => {
										if (e.key === 'Enter' || e.key === ' ') {
											e.preventDefault()
											onSelectRoom(room.id)
										}
									}}
								>
									<div className="workspace-card-content">
										<div className="workspace-card-header">
											<h3 className="workspace-card-name" title={room.name}>
												{room.name || '未命名白板'}
											</h3>
											{room.id === 'main' && (
												<span className="workspace-badge workspace-badge-main">主白板</span>
											)}
										</div>
										<div className="workspace-card-footer">
											<span className="workspace-card-id">ID: {room.id}</span>
											{room.createdAt && (
												<span className="workspace-card-date">
													{formatDate(room.createdAt)}
												</span>
											)}
										</div>
									</div>
									<div className="workspace-card-action">
										<span className="workspace-enter-link">进入 →</span>
									</div>
								</div>
							))}
						</div>
					)}
				</section>
			</main>
		</div>
	)
}
