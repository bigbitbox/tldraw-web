import { getAssetUrls } from '@tldraw/assets/selfHosted'

const defaults = getAssetUrls({ baseUrl: '/tldraw-assets' })
const drawFontUrl = '/fonts/Xiaolai-v3.126-Regular.woff2'

// 小赖字体 3.126，SIL OFL 许可见 /fonts/Xiaolai-LICENSE.txt。
// 共用稳定的资源对象，让画布与 AI 历史预览使用相同字体；粗体/斜体由浏览器合成。
export const assetUrls = {
	...defaults,
	fonts: {
		...defaults.fonts,
		tldraw_draw: drawFontUrl,
		tldraw_draw_bold: drawFontUrl,
		tldraw_draw_italic: drawFontUrl,
		tldraw_draw_italic_bold: drawFontUrl,
	},
}
