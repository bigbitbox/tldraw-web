# 绘图与图片操作

完整输入由 `tldraw schema board.apply` 给出。命令默认生成官方 SDK 5.4.2 的属性，最后由 SDK schema 验证。不创建整张替代画布；操作写入同一个实时同步房间。

## 修改已有形状

```json
{"expectedRevision":12,"operations":[
  {"op":"update","id":"shape:existing","text":"新标题","x":400,"props":{"color":"green"}}
]}
```

`props` 中的对象采用浅合并，例如修改 `start` 时必须提供完整 `{x,y}`。旋转是弧度。普通矩形、椭圆、菱形等使用 `type: geo` 配合 `props.geo`；文字使用 `type: text`，便签是 `note`，框架是 `frame`。颜色是 tldraw 的具名颜色（例如 blue、green、red、black），不是任意 CSS 色值。

## 自由绘图

用 `points` 描述形状局部坐标，CLI 编码成 SDK 的原生笔画。下面是折线轮廓的示意，不是曲线插值器；精细曲线需要足够密的采样点。

```json
{"expectedRevision":12,"operations":[
  {"op":"create","id":"shape:fin","type":"draw","x":200,"y":200,
   "points":[[0,0],[30,-20],[55,5],[0,0]],
   "props":{"color":"blue","size":"m","fill":"solid","isClosed":true,"dash":"solid"}}
]}
```

## 连线

箭头的 `start/end` 是相对于箭头 `x/y` 的坐标。绑定可让端点跟随目标形状移动；两个形状和箭头必须在同一页面。先创建形状与箭头，再绑定：

```json
{"expectedRevision":12,"operations":[
  {"op":"create","id":"shape:a","type":"geo","x":100,"y":100,"text":"输入","props":{"w":180,"h":100}},
  {"op":"create","id":"shape:b","type":"geo","x":420,"y":100,"text":"输出","props":{"w":180,"h":100}},
  {"op":"create","id":"shape:ab","type":"arrow","x":280,"y":150,"props":{"start":{"x":0,"y":0},"end":{"x":140,"y":0},"color":"blue"}},
  {"op":"bind","fromId":"shape:ab","toId":"shape:a","terminal":"start","anchor":{"x":1,"y":0.5}},
  {"op":"bind","fromId":"shape:ab","toId":"shape:b","terminal":"end","anchor":{"x":0,"y":0.5}}
]}
```

CLI 验证图形记录及引用，但没有浏览器编辑器的文字排版与几何布局引擎。给文字留足宽高，重要构图在浏览器中验收；结构写入成功不等于视觉效果已验证。

## 插入图片

```sh
tldraw asset add '<URL>' --file /tmp/image.png --if-revision 12 \
  --id shape:reference-image --x 100 --y 400 --width 600 --alt '参考图' --dry-run
```

确认位置后去掉 `--dry-run` 执行。CLI 自动检测图片尺寸、保持比例、上传附件并创建 image 形状，其他设备可以看到同一图片。PNG/JPEG/GIF/WebP/AVIF，最大 20 MiB。

附件上传与画布修改是两次请求。若期间有人修改画布，第二步会报告冲突；错误详情返回 asset 记录、uploadPath、shapeId 和 uploadConfirmed。上传响应超时可能意味着文件已存在但尚未创建形状，先检查上传路径；画布写入超时则先读画布核对 shapeId。未引用的上传文件不会自动清理。
