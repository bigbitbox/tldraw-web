export type Theme = 'light' | 'dark'

const STORAGE_KEY = 'app-theme'

export function getStoredTheme(): Theme | null {
	try {
		const value = localStorage.getItem(STORAGE_KEY)
		return value === 'light' || value === 'dark' ? value : null
	} catch {
		return null
	}
}

export function getSystemTheme(): Theme {
	if (typeof window !== 'undefined' && window.matchMedia('(prefers-color-scheme: dark)').matches) {
		return 'dark'
	}
	return 'light'
}

export function getInitialTheme(): Theme {
	return getStoredTheme() ?? getSystemTheme()
}

export function applyTheme(theme: Theme) {
	document.documentElement.dataset.theme = theme
	try {
		localStorage.setItem(STORAGE_KEY, theme)
	} catch {
		// localStorage unavailable, theme still applied for this session
	}
}

export function toggleTheme(theme: Theme): Theme {
	const next: Theme = theme === 'dark' ? 'light' : 'dark'
	applyTheme(next)
	return next
}

// Follow OS theme changes only when the user hasn't picked a theme manually.
export function watchSystemTheme() {
	if (typeof window === 'undefined' || !window.matchMedia) return
	const media = window.matchMedia('(prefers-color-scheme: dark)')
	const onChange = () => {
		if (getStoredTheme() === null) {
			document.documentElement.dataset.theme = media.matches ? 'dark' : 'light'
		}
	}
	media.addEventListener('change', onChange)
}
