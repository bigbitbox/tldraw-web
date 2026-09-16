import { useEffect, useState } from 'react'
import { getInitialTheme, toggleTheme, Theme } from '../theme'

function SunIcon() {
	return (
		<svg
			className="theme-toggle-icon"
			viewBox="0 0 24 24"
			fill="none"
			stroke="currentColor"
			strokeWidth="2"
			strokeLinecap="round"
			strokeLinejoin="round"
			aria-hidden="true"
		>
			<circle cx="12" cy="12" r="4" />
			<path d="M12 2v2" />
			<path d="M12 20v2" />
			<path d="m4.93 4.93 1.41 1.41" />
			<path d="m17.66 17.66 1.41 1.41" />
			<path d="M2 12h2" />
			<path d="M20 12h2" />
			<path d="m6.34 17.66-1.41 1.41" />
			<path d="m19.07 4.93-1.41 1.41" />
		</svg>
	)
}

function MoonIcon() {
	return (
		<svg
			className="theme-toggle-icon"
			viewBox="0 0 24 24"
			fill="none"
			stroke="currentColor"
			strokeWidth="2"
			strokeLinecap="round"
			strokeLinejoin="round"
			aria-hidden="true"
		>
			<path d="M12 3a6 6 0 0 0 9 9 9 9 0 1 1-9-9Z" />
		</svg>
	)
}

export function ThemeToggle() {
	const [theme, setTheme] = useState<Theme>(() => getInitialTheme())

	useEffect(() => {
		const media = window.matchMedia('(prefers-color-scheme: dark)')
		const onChange = () => setTheme(document.documentElement.dataset.theme === 'dark' ? 'dark' : 'light')
		media.addEventListener('change', onChange)
		return () => media.removeEventListener('change', onChange)
	}, [])

	return (
		<button
			type="button"
			className="theme-toggle-btn"
			onClick={() => setTheme((t) => toggleTheme(t))}
			title={theme === 'dark' ? '切换到浅色模式' : '切换到暗色模式'}
			aria-label={theme === 'dark' ? '切换到浅色模式' : '切换到暗色模式'}
		>
			{theme === 'dark' ? <SunIcon /> : <MoonIcon />}
		</button>
	)
}
