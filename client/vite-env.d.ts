/// <reference types="vite/client" />

interface ImportMetaEnv {
	readonly DEV_MODE?: string
	readonly VITE_TLDRAW_LICENSE_KEY?: string
}

interface ImportMeta {
	readonly env: ImportMetaEnv
}
