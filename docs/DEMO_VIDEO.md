# Architecture demo video

`docs/assets/llmward-architecture-demo.svg` is the source diagram for the short product demo. It communicates the product boundary accurately: LLMWard is a single-process, single-server OpenAI-compatible gateway; it stores operational metadata in SQLite but does not persist prompts or generated content.

The generated video is deliberately provider-neutral. It shows registered provider routes rather than claiming a specific provider integration or fallback behavior.

`docs/assets/llmward-architecture-demo.mp4` is the checked-in 15-second, silent 16:9 video. It has been visually reviewed from a rendered frame. Recreate it on macOS with Quick Look and FFmpeg:

```bash
sed 's/height="900" viewBox="0 0 1600 900"/height="1600" viewBox="0 0 1600 1600"/; s/<rect width="1600" height="900"/<rect width="1600" height="1600"/' \
  docs/assets/llmward-architecture-demo.svg > /tmp/llmward-architecture-video-frame.svg
qlmanage -t -s 1600 -o /tmp /tmp/llmward-architecture-video-frame.svg
ffmpeg -y -loop 1 -i /tmp/llmward-architecture-video-frame.svg.png -t 15 -r 30 \
  -vf "crop=1600:900:0:0,fade=t=in:st=0:d=1,fade=t=out:st=14:d=1" \
  -c:v libx264 -pix_fmt yuv420p docs/assets/llmward-architecture-demo.mp4
```

Before publishing, review the result for readability and pair it with a spoken or captioned explanation of the privacy boundary and the supported single-server deployment scope. Do not put real credentials, prompts, or personal information into a recording.
