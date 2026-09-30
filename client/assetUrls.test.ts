import assert from 'node:assert/strict'
import { test } from 'node:test'
import { defaultAddFontsFromNode, DefaultFontFaces, Editor, getFontsFromRichText, tipTapDefaultExtensions } from 'tldraw'
import { addFontsFromNode, assetUrls } from './assetUrls'

test('draw 字体中英文混排及粗体/斜体扫描，英文保留官方资源', () => {
	const scan = (text: string, marks: { type: string }[] = [], family = 'tldraw_draw', visitor = addFontsFromNode) =>
		getFontsFromRichText({
			getTextOptions: () => ({ addFontsFromNode: visitor, tipTapConfig: { extensions: tipTapDefaultExtensions } }),
		} as Editor, {
			type: 'doc', content: [{ type: 'paragraph', content: [{ type: 'text', text, marks }] }],
		}, { family, weight: 'normal', style: 'normal' })

	assert.match(assetUrls.fonts.tldraw_draw, /Shantell_Sans-Informal_Regular\.woff2$/)
	assert.deepEqual(scan('Hello, ABC 123!'), [DefaultFontFaces.tldraw_draw.normal.normal])
	for (const marks of [[], [{ type: 'bold' }], [{ type: 'italic' }], [{ type: 'bold' }, { type: 'italic' }]]) {
		const faces = scan('你好，世界！Hello 123', marks)
		const native = faces.filter((font) => !font.unicodeRange)
		const chinese = faces.filter((font) => font.unicodeRange)
		assert.deepEqual(native, scan('你好，世界！Hello 123', marks, 'tldraw_draw', defaultAddFontsFromNode))
		assert.equal(chinese.length, 1)
		assert.match(chinese[0].src.url, /Xiaolai/)
		assert.equal(chinese[0].family, native.at(-1)!.family)
		assert.equal(chinese[0].weight, native.at(-1)!.weight)
		assert.equal(chinese[0].style, native.at(-1)!.style)
	}
	assert.equal(scan('你好', [], 'tldraw_sans').length, 1)
	assert.deepEqual(scan('中文 Hello', [{ type: 'code' }]), scan('中文 Hello', [{ type: 'code' }], 'tldraw_draw', defaultAddFontsFromNode))
})
