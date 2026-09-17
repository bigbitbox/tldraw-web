import { FormEvent, useEffect, useRef, useState } from 'react'
import { createRoom, deleteRoom, getRooms, reorderRooms, RoomInfo } from '../api'
import { ThemeToggle } from './ThemeToggle'

interface WorkspaceListProps {
	onSelectRoom: (roomId: string) => void
	onLogout: () => void
}

// 拖拽时按指针位置找卡片：只在指针真正落到另一张卡片上时换位，避免误触发。
function roomIdAtPoint(x: number, y: number): string | null {
	for (const card of Array.from(document.querySelectorAll<HTMLElement>('[data-room-id]'))) {
		const rect = card.getBoundingClientRect()
		if (x >= rect.left && x <= rect.right && y >= rect.top && y <= rect.bottom) {
			return card.dataset.roomId ?? null
		}
	}
	return null
}

function moveId(ids: string[], id: string, to: number): string[] {
	const from = ids.indexOf(id)
	if (from < 0 || to < 0 || to >= ids.length || from === to) return ids
	const next = ids.slice()
	next.splice(to, 0, next.splice(from, 1)[0])
	return next
}

export function WorkspaceList({ onSelectRoom, onLogout }: WorkspaceListProps) {
	const [rooms, setRooms] = useState<RoomInfo[]>([])
	const [loading, setLoading] = useState(true)
	const [error, setError] = useState<string | null>(null)
	const [newRoomName, setNewRoomName] = useState('')
	const [creating, setCreating] = useState(false)
	const [createError, setCreateError] = useState<string | null>(null)
	const [draggingId, setDraggingId] = useState<string | null>(null)
	const [pendingDelete, setPendingDelete] = useState<RoomInfo | null>(null)
	const [deleting, setDeleting] = useState(false)
	const [notice, setNotice] = useState<string | null>(null)

	const roomsRef = useRef<RoomInfo[]>([])
	// 拖拽开始时的顺序，用于判断是否需要写回服务器
	const orderBeforeDrag = useRef<string[]>([])
	// 拖拽中的期望顺序：同步维护，不依赖 React 提交时机
	const dragOrder = useRef<string[] | null>(null)
	const movedDuringDrag = useRef(false)
	// 刚拖完的一次 click 不应该被当成「进入白板」
	const justDragged = useRef(false)

	useEffect(() => {
		roomsRef.current = rooms
	}, [rooms])

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

	// 提示条自动消失
	useEffect(() => {
		if (!notice) return
		const timer = window.setTimeout(() => setNotice(null), 4000)
		return () => window.clearTimeout(timer)
	}, [notice])

	// 拖拽期间监听 window：指针移到哪张卡片上，就把拖动中的卡片插到那个位置。
	useEffect(() => {
		if (!draggingId) return
		const previousUserSelect = document.body.style.userSelect
		document.body.style.userSelect = 'none'

		const move = (event: PointerEvent) => {
			const targetId = roomIdAtPoint(event.clientX, event.clientY)
			const current = dragOrder.current ?? orderBeforeDrag.current
			const from = current.indexOf(draggingId)
			const to = targetId ? current.indexOf(targetId) : -1
			if (from < 0 || to < 0 || from === to) return
			movedDuringDrag.current = true
			applyOrder(moveId(current, draggingId, to))
		}

		const finish = () => {
			setDraggingId(null)
			const ids = dragOrder.current
			dragOrder.current = null
			if (!movedDuringDrag.current || !ids) return
			justDragged.current = true
			window.setTimeout(() => {
				justDragged.current = false
			}, 300)
			if (ids.join() === orderBeforeDrag.current.join()) return
			saveOrder(ids)
		}

		window.addEventListener('pointermove', move)
		window.addEventListener('pointerup', finish)
		window.addEventListener('pointercancel', finish)
		return () => {
			document.body.style.userSelect = previousUserSelect
			window.removeEventListener('pointermove', move)
			window.removeEventListener('pointerup', finish)
			window.removeEventListener('pointercancel', finish)
		}
	}, [draggingId])

	// 删除确认框：Esc 关闭
	useEffect(() => {
		if (!pendingDelete) return
		const onKeyDown = (event: KeyboardEvent) => {
			if (event.key === 'Escape') setPendingDelete(null)
		}
		window.addEventListener('keydown', onKeyDown)
		return () => window.removeEventListener('keydown', onKeyDown)
	}, [pendingDelete])

	// 本地先按新顺序渲染（保持同一批 room 对象），成功后以服务器返回的顺序为准
	const applyOrder = (ids: string[]) => {
		const byId = new Map(roomsRef.current.map((room) => [room.id, room]))
		roomsRef.current = ids.map((id) => byId.get(id)).filter((room): room is RoomInfo => Boolean(room))
		dragOrder.current = ids
		setRooms(roomsRef.current)
	}

	const saveOrder = (ids: string[]) => {
		reorderRooms(ids)
			.then((updated) => {
				if (updated.length) setRooms(updated)
			})
			.catch((err: any) => {
				setNotice(err?.message || '保存白板顺序失败，已恢复原顺序')
				loadRooms()
			})
	}

	const startDrag = (event: React.PointerEvent<HTMLElement>, roomId: string) => {
		if (event.pointerType === 'mouse' && event.button !== 0) return
		event.preventDefault()
		event.stopPropagation()
		orderBeforeDrag.current = roomsRef.current.map((room) => room.id)
		dragOrder.current = orderBeforeDrag.current.slice()
		movedDuringDrag.current = false
		setDraggingId(roomId)
	}

	// 键盘等价操作：卡片获得焦点后用 Alt + 上下键移动，顺序同样写回服务器。
	const handleMoveKey = (roomId: string, delta: number) => {
		const ids = roomsRef.current.map((room) => room.id)
		const from = ids.indexOf(roomId)
		const next = moveId(ids, roomId, from + delta)
		if (next === ids) return
		applyOrder(next)
		saveOrder(next)
	}

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

	const confirmDelete = async () => {
		const target = pendingDelete
		if (!target) return
		setDeleting(true)
		try {
			await deleteRoom(target.id)
			setRooms((prev) => prev.filter((room) => room.id !== target.id))
			setNotice(`已删除「${target.name || target.id}」`)
			setPendingDelete(null)
		} catch (err: any) {
			setNotice(err?.message || '删除白板失败，请重试')
		} finally {
			setDeleting(false)
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
					<div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
						<ThemeToggle />
						<button type="button" className="workspace-logout-btn" onClick={onLogout}>
							退出登录
						</button>
					</div>
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
						<div className="workspace-section-actions">
							<span className="workspace-section-hint">拖拽卡片可排序</span>
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
									data-room-id={room.id}
									className={`workspace-card${draggingId === room.id ? ' workspace-card-dragging' : ''}`}
									onClick={() => {
										if (draggingId || justDragged.current) return
										onSelectRoom(room.id)
									}}
									role="button"
									tabIndex={0}
									onKeyDown={(e) => {
										if (e.altKey && (e.key === 'ArrowUp' || e.key === 'ArrowDown')) {
											e.preventDefault()
											handleMoveKey(room.id, e.key === 'ArrowUp' ? -1 : 1)
											return
										}
										if (e.key === 'Enter' || e.key === ' ') {
											e.preventDefault()
											onSelectRoom(room.id)
										}
									}}
								>
									<div className="workspace-card-content">
										<div className="workspace-card-header">
											<button
												type="button"
												className="workspace-card-handle"
												onPointerDown={(e) => startDrag(e, room.id)}
												onClick={(e) => e.stopPropagation()}
												title="拖拽调整顺序，或用 Alt + ↑/↓ 移动"
												aria-label={`拖拽调整「${room.name || room.id}」的顺序`}
											>
												<svg viewBox="0 0 24 24" fill="currentColor" aria-hidden="true">
													<circle cx="9" cy="6" r="1.6" />
													<circle cx="15" cy="6" r="1.6" />
													<circle cx="9" cy="12" r="1.6" />
													<circle cx="15" cy="12" r="1.6" />
													<circle cx="9" cy="18" r="1.6" />
													<circle cx="15" cy="18" r="1.6" />
												</svg>
											</button>
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
										<button
											type="button"
											className="workspace-card-delete"
											disabled={room.id === 'main'}
											title={room.id === 'main' ? '主白板不能删除' : '删除白板'}
											aria-label={`删除「${room.name || room.id}」`}
											onClick={(e) => {
												e.stopPropagation()
												setPendingDelete(room)
											}}
										>
											<svg
												viewBox="0 0 24 24"
												fill="none"
												stroke="currentColor"
												strokeWidth="2"
												strokeLinecap="round"
												strokeLinejoin="round"
												aria-hidden="true"
											>
												<path d="M3 6h18" />
												<path d="M8 6V4h8v2" />
												<path d="M19 6l-1 14H6L5 6" />
												<path d="M10 11v6M14 11v6" />
											</svg>
										</button>
										<span className="workspace-enter-link">进入 →</span>
									</div>
								</div>
							))}
						</div>
					)}
				</section>
			</main>

			{pendingDelete && (
				<div
					className="workspace-dialog-backdrop"
					onClick={() => {
						if (!deleting) setPendingDelete(null)
					}}
				>
					<div
						className="workspace-dialog"
						role="dialog"
						aria-modal="true"
						aria-labelledby="workspace-delete-title"
						onClick={(e) => e.stopPropagation()}
					>
						<h2 className="workspace-dialog-title" id="workspace-delete-title">
							删除白板
						</h2>
						<p className="workspace-dialog-text">
							确定删除「{pendingDelete.name || pendingDelete.id}
							」吗？该白板的内容与附件会一并删除，无法恢复。
						</p>
						<div className="workspace-dialog-actions">
							<button
								type="button"
								className="workspace-dialog-btn"
								onClick={() => setPendingDelete(null)}
								disabled={deleting}
								autoFocus
							>
								取消
							</button>
							<button
								type="button"
								className="workspace-dialog-btn workspace-dialog-btn-danger"
								onClick={confirmDelete}
								disabled={deleting}
							>
								{deleting ? '删除中...' : '删除'}
							</button>
						</div>
					</div>
				</div>
			)}

			{notice && (
				<div className="workspace-notice" role="status">
					{notice}
				</div>
			)}
		</div>
	)
}
