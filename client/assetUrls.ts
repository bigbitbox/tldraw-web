import { getAssetUrls } from '@tldraw/assets/selfHosted'
import { allDefaultFontFaces, defaultAddFontsFromNode, type RichTextFontVisitor } from 'tldraw'

export const assetUrls = getAssetUrls({ baseUrl: '/tldraw-assets' })

// 小赖字体 3.126，SIL OFL 许可见 /fonts/Xiaolai-LICENSE.txt。
// 同一字体族按 unicode-range 混排：英文保留官方字形，中文使用小赖。
// 通过 SDK 字体扫描注册，确保文字测量、AI 历史预览和 SVG/PNG 导出都能获取两套字体。
const chinesePattern = /[\u2E80-\u9FFF\uF900-\uFAFF\uFE10-\uFE1F\uFE30-\uFFEF\u{20000}-\u{323AF}]/u
const chineseFaces = new Map(
	allDefaultFontFaces
		.filter((font) => font.family === 'tldraw_draw')
		.map((font) => [font, {
			...font,
			src: { url: '/fonts/Xiaolai-v3.126-Regular.woff2', format: 'woff2' },
			unicodeRange: 'U+2E80-9FFF,U+F900-FAFF,U+FE10-FE1F,U+FE30-FFEF,U+20000-323AF',
		}])
)

export const addFontsFromNode: RichTextFontVisitor = (node, state, addFont) =>
	defaultAddFontsFromNode(node, state, (font) => {
		addFont(font)
		const chineseFace = chineseFaces.get(font)
		if (chineseFace && node.isText && chinesePattern.test(node.text ?? '')) {
			addFont(chineseFace)
		}
	})
