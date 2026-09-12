import { useCallback, useEffect, useState } from 'react'
import { getSession, logoutSession } from './api'
import { LoginForm } from './components/LoginForm'
import { WorkspaceList } from './components/WorkspaceList'
import { RoomView } from './components/RoomView'

function App() {
	const [authenticated, setAuthenticated] = useState<boolean | null>(null)
	const [currentPath, setCurrentPath] = useState<string>(() =>
		typeof window !== 'undefined' ? window.location.pathname : '/'
	)

	// Check auth session on load
	useEffect(() => {
		let isMounted = true
		getSession().then((isAuth) => {
			if (isMounted) {
				setAuthenticated(isAuth)
			}
		})
		return () => {
			isMounted = false
		}
	}, [])

	// Listen for browser back/forward navigation
	useEffect(() => {
		const handlePopState = () => {
			setCurrentPath(window.location.pathname)
		}
		window.addEventListener('popstate', handlePopState)
		return () => {
			window.removeEventListener('popstate', handlePopState)
		}
	}, [])

	const navigate = useCallback((to: string) => {
		window.history.pushState({}, '', to)
		setCurrentPath(to)
	}, [])

	const handleLogout = useCallback(async () => {
		await logoutSession()
		setAuthenticated(false)
	}, [])

	// Initial session check loading
	if (authenticated === null) {
		return (
			<div className="auth-loading-screen">
				<div className="workspace-spinner" />
			</div>
		)
	}

	// Unauthenticated view
	if (!authenticated) {
		return (
			<LoginForm
				onSuccess={() => {
					setAuthenticated(true)
				}}
			/>
		)
	}

	// Route resolution: /r/:roomId vs workspace list (/)
	const roomMatch = currentPath.match(/^\/r\/([^/?#]+)/)

	if (roomMatch && roomMatch[1]) {
		const roomId = decodeURIComponent(roomMatch[1])
		return (
			<RoomView
				key={roomId}
				roomId={roomId}
				onBack={() => navigate('/')}
				onLogout={handleLogout}
			/>
		)
	}

	return (
		<WorkspaceList
			onSelectRoom={(roomId) => navigate(`/r/${encodeURIComponent(roomId)}`)}
			onLogout={handleLogout}
		/>
	)
}

export default App
