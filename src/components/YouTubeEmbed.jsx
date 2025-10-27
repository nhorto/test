export default function YouTubeEmbed({ url, title, aspectRatio = "9 / 16" }) {
  const normalizedUrl = (() => {
    try {
      const parsed = new URL(url);
      parsed.host = "www.youtube-nocookie.com";
      if (!parsed.searchParams.has("rel")) {
        parsed.searchParams.set("rel", "0");
      }
      return parsed.toString();
    } catch (error) {
      return url;
    }
  })();

  return (
    <div
      className="relative w-full overflow-hidden rounded-3xl bg-black shadow-2xl ring-1 ring-black/10"
      style={{ aspectRatio }}
    >
      <iframe
        className="absolute left-0 top-0 h-full w-full"
        src={normalizedUrl}
        title={title}
        loading="lazy"
        allow="accelerometer; autoplay; clipboard-write; encrypted-media; gyroscope; picture-in-picture; web-share"
        referrerPolicy="strict-origin-when-cross-origin"
        allowFullScreen
      />
    </div>
  );
}
