import Link from "next/link";
import Image from "next/image";

const variantStyles = {
  blog: {
    ctaLabel: "Read More",
  },
  recipe: {
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
  image,
  imageAlt,
}) {
  const styles = variantStyles[variant] ?? variantStyles.blog;
  const buttonText = ctaLabel ?? styles.ctaLabel;
  const resolvedImageAlt = imageAlt?.trim() || title;

  return (
    <article className="flex h-full w-full flex-col overflow-hidden rounded-3xl bg-white/90 shadow-xl ring-1 ring-black/5 transition duration-300 hover:-translate-y-1 hover:shadow-2xl">
      {image && (
        <Link href={href} className="relative block h-56 w-full overflow-hidden">
          <Image
            src={image}
            alt={resolvedImageAlt}
            fill
            className="object-cover transition-transform duration-500 hover:scale-105"
            sizes="(min-width: 1024px) 23rem, (min-width: 640px) 45vw, 92vw"
            priority={false}
          />
        </Link>
      )}
      <div className="flex flex-1 flex-col gap-4 px-6 py-2">
        {(meta || category) && (
          <div className="flex flex-wrap items-center justify-between gap-3 text-sm">
            {meta && <p className="font-medium text-gray-500">{meta}</p>}

            {category && (
              <Link
                href={`/category/${category.toLowerCase()}`}
                className="inline-flex items-center rounded-full bg-[#69ACC1] px-3 py-1 text-xs font-semibold uppercase tracking-[0.25em] text-[#2B2723] transition-colors hover:bg-[#D6E6F5]"
              >
                {category}
              </Link>
            )}
          </div>
        )}

        <Link
          href={href}
          className="text-2xl font-bold leading-tight text-[#2B2723] transition-colors hover:text-[#4B433C]"
        >
          {title}
        </Link>

        {description && (
          <p className="text-base font-medium text-[#4B433C]/80 md:text-lg">
            {description}
          </p>
        )}
      </div>
    </article>
  );
}
