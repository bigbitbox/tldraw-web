import { useCallback, useEffect, useMemo, useState } from 'react'
import {
	AssetRecordType,
	DefaultSizeStyle,
	Editor,
	ErrorBoundary,
	getHashForString,
	TLComponents,
	Tldraw,
	TldrawUiToastsProvider,
	TLUiOverrides,
	uniqueId,
	TLAssetStore,
} from 'tldraw'
import { useSync } from '@tldraw/sync'
import { getAssetUrls } from '@tldraw/assets/selfHosted'
import { getRooms, renameRoom } from '../api'
import { TldrawAgentApp } from '../agent/TldrawAgentApp'
import {
	TldrawAgentAppContextProvider,
	TldrawAgentAppProvider,
} from '../agent/TldrawAgentAppProvider'
import { ChatPanel } from './ChatPanel'
import { ChatPanelFallback } from './ChatPanelFallback'
import { CustomHelperButtons } from './CustomHelperButtons'
import { AgentHighlightOverlayUtil } from '../overlays/AgentHighlightOverlayUtil'
import { TargetAreaTool } from '../tools/TargetAreaTool'
import { TargetShapeTool } from '../tools/TargetShapeTool'
import { RoomHeader } from './RoomHeader'

DefaultSizeStyle.setDefaultValue('s')

const tools = [TargetShapeTool, TargetAreaTool]
const overlayUtils = [AgentHighlightOverlayUtil]
const overrides: TLUiOverrides = {
	tools: (editor, tools) => {
		return {
			...tools,
			'target-area': {
				id: 'target-area',
				label: 'Pick Area',
				kbd: 'c',
				icon: 'tool-frame',
				onSelect() {
					editor.setCurrentTool('target-area')
				},
			},
			'target-shape': {
				id: 'target-shape',
				label: 'Pick Shape',
				kbd: 's',
				icon: 'tool-frame',
				onSelect() {
					editor.setCurrentTool('target-shape')
				},
			},
		}
	},
}

interface RoomViewProps {
	roomId: string
	onBack: () => void
	onLogout: () => void
}

export function RoomView({ roomId, onBack, onLogout }: RoomViewProps) {
	const [app, setApp] = useState<TldrawAgentApp | null>(null)
	const [roomName, setRoomName] = useState<string>(roomId)
	const [isSidebarOpen, setIsSidebarOpen] = useState<boolean>(() => {
		if (typeof window !== 'undefined') {
			return window.innerWidth > 768
		}
		return true
	})

	// Fetch room details on mount
	useEffect(() => {
		let isMounted = true
		getRooms()
			.then((rooms) => {
				if (!isMounted) return
				const current = rooms.find((r) => r.id === roomId)
				if (current?.name) {
					setRoomName(current.name)
				}
			})
			.catch(() => {
				// Ignore if error, fallback to roomId
			})
		return () => {
			isMounted = false
		}
	}, [roomId])

	const handleRenameRoom = useCallback(
		async (newName: string) => {
			await renameRoom(roomId, newName)
			setRoomName(newName)
		},
		[roomId]
	)

	const handleUnmount = useCallback(() => {
		setApp(null)
	}, [])

	const handleEditorMount = useCallback((editor: Editor) => {
		// Register default bookmark handler without server unfurl
		editor.registerExternalAssetHandler('url', async ({ url }) => {
			return {
				id: AssetRecordType.createId(getHashForString(url)),
				typeName: 'asset',
				type: 'bookmark',
				props: {
					src: url,
					description: '',
					image: '',
					favicon: '',
					title: url,
				},
				meta: {},
			}
		})

		// Expose editor for dev testing if DEV_MODE is enabled
		if (import.meta.env.DEV_MODE === 'true') {
			;(window as any).editor = editor
		}
	}, [])

	// Asset store using PUT /uploads/:id and GET /uploads/:id
	const assetStore: TLAssetStore = useMemo(() => {
		return {
			async upload(_asset, file, abortSignal) {
				const sanitized = (file.name || 'file').replace(/[^a-zA-Z0-9._-]/g, '_')
				const uploadId = `${uniqueId()}-${sanitized}`
				const res = await fetch(`/uploads/${encodeURIComponent(uploadId)}`, {
					method: 'PUT',
					headers: {
						'Content-Type': file.type || 'application/octet-stream',
					},
					body: file,
					credentials: 'same-origin',
					signal: abortSignal,
				})
				if (!res.ok) {
					throw new Error(`Upload failed (${res.status}): ${res.statusText}`)
				}
				return { src: `/uploads/${encodeURIComponent(uploadId)}` }
			},
			resolve(asset) {
				return asset.props.src
			},
		}
	}, [])

	// WebSocket URL for room sync
	const wsUri = useMemo(() => {
		const protocol = window.location.protocol === 'https:' ? 'wss:' : 'ws:'
		return `${protocol}//${window.location.host}/connect/${encodeURIComponent(roomId)}`
	}, [roomId])

	const syncOptions = useMemo(
		() => ({
			uri: wsUri,
			assets: assetStore,
			roomId,
		}),
		[wsUri, assetStore, roomId]
	)

	// Collaborative store via @tldraw/sync
	const store = useSync(syncOptions)

	// Self-hosted asset URLs
	// 画笔(draw)字体官方只有拉丁字形,中文会回退成系统黑体;
	// 这里把 draw 字体的 4 个字重槽位都指向站酷快乐体(SIL OFL 授权,见 /fonts/ZCOOLKuaiLe-LICENSE.txt),
	// 让中文文本也保持卡通手写风格。字体仅一个 Regular 字重,粗体/斜体由浏览器合成。
	const ZCOOL_KUAILE_URL = '/fonts/ZCOOLKuaiLe-Regular.woff2'
	const assetUrls = useMemo(() => {
		const defaults = getAssetUrls({ baseUrl: '/tldraw-assets' })
		return {
			...defaults,
			fonts: {
				...defaults.fonts,
				tldraw_draw: ZCOOL_KUAILE_URL,
				tldraw_draw_bold: ZCOOL_KUAILE_URL,
				tldraw_draw_italic: ZCOOL_KUAILE_URL,
				tldraw_draw_italic_bold: ZCOOL_KUAILE_URL,
			},
		}
	}, [])

	const licenseKey = import.meta.env.VITE_TLDRAW_LICENSE_KEY || undefined

	// 官方 zoomSteps 为 [0.05, 0.1, 0.25, 0.5, 1, 2, 4, 8],Cmd+/- 一次跨档过大;
	// 改为 10% 步进(0.1~4.0),首尾值即缩放上下限。
	const cameraOptions = useMemo(
		() => ({
			camera: {
				zoomSteps: Array.from({ length: 40 }, (_, i) => (i + 1) / 10),
			},
		}),
		[]
	)

	const components: TLComponents = useMemo(() => {
		return {
			HelperButtons: () =>
				app && (
					<TldrawAgentAppContextProvider app={app}>
						<CustomHelperButtons />
					</TldrawAgentAppContextProvider>
				),
		}
	}, [app])

	return (
		<div className="room-layout">
			<RoomHeader
				roomId={roomId}
				roomName={roomName}
				syncStatus={store.status}
				connectionStatus={store.status === 'synced-remote' ? store.connectionStatus : undefined}
				isSidebarOpen={isSidebarOpen}
				onToggleSidebar={() => setIsSidebarOpen((prev) => !prev)}
				onBack={onBack}
				onRenameRoom={handleRenameRoom}
				onLogout={onLogout}
			/>

			<div className="room-body">
				<TldrawUiToastsProvider>
					<div className={`tldraw-agent-container ${isSidebarOpen ? '' : 'sidebar-closed'}`}>
						<div className="tldraw-canvas">
							<Tldraw
								store={store}
								assetUrls={assetUrls}
								licenseKey={licenseKey}
								tools={tools}
								overlayUtils={overlayUtils}
								overrides={overrides}
								components={components}
								options={cameraOptions}
								onMount={handleEditorMount}
							>
								<TldrawAgentAppProvider onMount={setApp} onUnmount={handleUnmount} />
							</Tldraw>
						</div>
						{isSidebarOpen && (
							<ErrorBoundary fallback={ChatPanelFallback}>
								{app && (
									<TldrawAgentAppContextProvider app={app}>
										<ChatPanel />
									</TldrawAgentAppContextProvider>
								)}
							</ErrorBoundary>
						)}
					</div>
				</TldrawUiToastsProvider>
			</div>
		</div>
	)
}
