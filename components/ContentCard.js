import Link from "next/link";

const variantStyles = {
  blog: {
    gradient: "bg-gradient-to-br from-[#FFF6F9] via-white to-[#DAEEE8]",
    shadow: "shadow-[#a8d9cf]/30",
    ctaLabel: "Read More",
  },
  recipe: {
    gradient: "bg-gradient-to-br from-[#DAEEE8] via-white to-[#FFF6F9]",
    shadow: "shadow-[#b8dceb]/30",
    ctaLabel: "View Recipe",
  },
};

export default function ContentCard({
  title,
  description,
  href = "#",
  category,
  meta,
  variant = "blog",
  ctaLabel,
}) {
  const styles = variantStyles[variant] ?? variantStyles.blog;
  const buttonText = ctaLabel ?? styles.ctaLabel;

  return (
    <article className="flex h-full flex-col overflow-hidden rounded-3xl bg-white/80 shadow-lg ring-1 ring-black/5 transition hover:-translate-y-1 hover:shadow-xl">
      <div className={`h-48 ${styles.gradient}`} />
      <div className={`flex flex-1 flex-col p-8 ${styles.shadow}`}>
        <div className="flex items-center gap-4 text-xs font-semibold uppercase tracking-[0.35em] text-[#8C7866]">
          {category && (
            <span className="rounded-full bg-[#FFF6F9]/80 px-3 py-1 text-[0.625rem] tracking-[0.25em] text-[#5B4B3F]">
              {category}
            </span>
          )}
          {meta && (
            <span className="ml-auto text-[0.6rem] tracking-[0.2em] text-[#253C57]/60">
              {meta}
            </span>
          )}
        </div>
        <h3 className="mt-6 text-2xl font-semibold text-[#253C57]">{title}</h3>
        {description && (
          <p className="mt-4 flex-1 text-base leading-relaxed text-[#4B433C]">
            {description}
          </p>
        )}
        <Link
          href={href}
          className="mt-8 inline-flex items-center justify-center rounded-full bg-[#253C57] px-6 py-2 text-sm font-semibold uppercase tracking-[0.25em] text-white transition hover:bg-[#1C2D40]"
        >
          {buttonText}
        </Link>
      </div>
    </article>
  );
}
