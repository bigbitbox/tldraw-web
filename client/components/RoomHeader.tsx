import { KeyboardEvent, useEffect, useRef, useState } from 'react'
import type { RemoteTLStoreWithStatus } from '@tldraw/sync'

interface RoomHeaderProps {
	roomId: string
	roomName: string
	syncStatus: RemoteTLStoreWithStatus['status']
	connectionStatus?: 'online' | 'offline'
	isSidebarOpen: boolean
	onToggleSidebar: () => void
	onBack: () => void
	onRenameRoom?: (newName: string) => Promise<void>
	onLogout: () => void
}

export function RoomHeader({
	roomId,
	roomName,
	syncStatus,
	connectionStatus = 'online',
	isSidebarOpen,
	onToggleSidebar,
	onBack,
	onRenameRoom,
	onLogout,
}: RoomHeaderProps) {
	const [isEditingName, setIsEditingName] = useState(false)
	const [nameInput, setNameInput] = useState(roomName)
	const [savingName, setSavingName] = useState(false)
	const inputRef = useRef<HTMLInputElement>(null)

	useEffect(() => {
		setNameInput(roomName)
	}, [roomName])

	useEffect(() => {
		if (isEditingName && inputRef.current) {
			inputRef.current.focus()
			inputRef.current.select()
		}
	}, [isEditingName])

	const handleSaveName = async () => {
		const trimmed = nameInput.trim()
		if (!trimmed || trimmed === roomName) {
			setNameInput(roomName)
			setIsEditingName(false)
			return
		}

		if (onRenameRoom) {
			setSavingName(true)
			try {
				await onRenameRoom(trimmed)
			} catch (e) {
				console.error('Failed to rename room:', e)
				setNameInput(roomName)
			} finally {
				setSavingName(false)
				setIsEditingName(false)
			}
		} else {
			setIsEditingName(false)
		}
	}

	const handleKeyDown = (e: KeyboardEvent<HTMLInputElement>) => {
		if (e.key === 'Enter') {
			e.preventDefault()
			handleSaveName()
		} else if (e.key === 'Escape') {
			setNameInput(roomName)
			setIsEditingName(false)
		}
	}

	const renderSyncIndicator = () => {
		if (syncStatus === 'synced-remote') {
			const isOnline = connectionStatus === 'online'
			return (
				<div className="room-sync-badge room-sync-synced" title={isOnline ? '云端已同步' : '离线模式'}>
					<span className="room-sync-dot" />
					<span className="room-sync-text">{isOnline ? '已同步' : '离线'}</span>
				</div>
			)
		}

		if (syncStatus === 'loading') {
			return (
				<div className="room-sync-badge room-sync-loading" title="正在连接协作服务...">
					<span className="room-sync-dot room-sync-dot-pulsing" />
					<span className="room-sync-text">同步中</span>
				</div>
			)
		}

		return (
			<div className="room-sync-badge room-sync-error" title="连接异常，正在尝试重连">
				<span className="room-sync-dot" />
				<span className="room-sync-text">未连接</span>
			</div>
		)
	}

	return (
		<header className="room-header-bar">
			<div className="room-header-left">
				<button type="button" className="room-back-btn" onClick={onBack} title="返回工作区">
					<svg
						className="room-btn-icon"
						viewBox="0 0 24 24"
						fill="none"
						stroke="currentColor"
						strokeWidth="2"
						strokeLinecap="round"
						strokeLinejoin="round"
					>
						<path d="M19 12H5" />
						<path d="M12 19l-7-7 7-7" />
					</svg>
					<span className="room-back-btn-text">工作区</span>
				</button>

				<div className="room-title-area">
					{isEditingName ? (
						<input
							ref={inputRef}
							type="text"
							className="room-name-input"
							value={nameInput}
							onChange={(e) => setNameInput(e.target.value)}
							onBlur={handleSaveName}
							onKeyDown={handleKeyDown}
							disabled={savingName}
							maxLength={64}
						/>
					) : (
						<button
							type="button"
							className="room-name-btn"
							onClick={() => onRenameRoom && setIsEditingName(true)}
							title="点击修改白板名称"
						>
							<span className="room-name-text">{roomName || roomId}</span>
							{onRenameRoom && (
								<svg
									className="room-edit-icon"
									viewBox="0 0 24 24"
									fill="none"
									stroke="currentColor"
									strokeWidth="2"
									strokeLinecap="round"
									strokeLinejoin="round"
								>
									<path d="M11 4H4a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2v-7" />
									<path d="M18.5 2.5a2.121 2.121 0 0 1 3 3L12 15l-4 1 1-4 9.5-9.5z" />
								</svg>
							)}
						</button>
					)}
				</div>
			</div>

			<div className="room-header-right">
				{renderSyncIndicator()}

				<button
					type="button"
					className={`room-sidebar-toggle-btn ${isSidebarOpen ? 'active' : ''}`}
					onClick={onToggleSidebar}
					title={isSidebarOpen ? '收起 AI 助手' : '展开 AI 助手'}
				>
					<svg
						className="room-btn-icon"
						viewBox="0 0 24 24"
						fill="none"
						stroke="currentColor"
						strokeWidth="2"
						strokeLinecap="round"
						strokeLinejoin="round"
					>
						<path d="M12 2a4 4 0 0 1 4 4v2a4 4 0 0 1-8 0V6a4 4 0 0 1 4-4z" />
						<path d="M18 10v2a6 6 0 0 1-12 0v-2" />
						<line x1="12" y1="18" x2="12" y2="22" />
						<line x1="8" y1="22" x2="16" y2="22" />
					</svg>
					<span className="room-toggle-btn-text">AI 助手</span>
				</button>

				<button type="button" className="room-logout-btn" onClick={onLogout} title="退出当前登录">
					退出
				</button>
			</div>
		</header>
	)
}
