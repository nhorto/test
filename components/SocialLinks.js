const socialLinks = [
  {
    name: "Instagram",
    href: "https://www.instagram.com/holisticbravo?igsh=bWozMmgzcWI1ZHJq",
    icon: ({ className = "", ...props }) => (
      <i
        className={`lni lni-instagram ${className}`.trim()}
        aria-hidden="true"
        {...props}
      />
    ),
  },
  {
    name: "YouTube",
    href: "https://youtube.com/@holisticbravo?si=O6VxmBgbOyGRfxOm",
    icon: ({ className = "", ...props }) => (
      <i
        className={`lni lni-youtube ${className}`.trim()}
        aria-hidden="true"
        {...props}
      />
    ),
  },
  {
    name: "TikTok",
    href: "https://www.tiktok.com/@holistic.bravo?_t=ZT-90KsYvaLFmv&_r=1",
    icon: ({ className = "", ...props }) => (
      <i
        className={`lni lni-tiktok ${className}`.trim()}
        aria-hidden="true"
        {...props}
      />
    ),
  },
];

export default function SocialLinks({
  wrapperClassName = "flex items-center gap-4",
  itemClassName = "text-gray-500 transition hover:text-teal-600",
  iconClassName = "",
  iconSizePx = 40,
}) {
  return (
    <div className={wrapperClassName}>
      {socialLinks.map((link) => (
        <a
          key={link.name}
          href={link.href}
          aria-label={link.name}
          className={itemClassName}
        >
          <link.icon
            className={`leading-none ${iconClassName}`.trim()}
            style={{ fontSize: `${iconSizePx}px` }}
          />
        </a>
      ))}
    </div>
  );
}
