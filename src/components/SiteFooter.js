import Link from "next/link";

import SocialLinks from "@/components/SocialLinks";

const FOOTER_LINKS = [
  { label: "Home", href: "/" },
  { label: "Recipes", href: "/recipes" },
  { label: "Blog", href: "/blog" },
];

export default function SiteFooter({ logoClassName = "" }) {
  const currentYear = new Date().getFullYear();

  return (
    <footer className="bg-white text-[#2B2723]">
      <div className="mx-auto max-w-6xl px-6 pb-10 pt-12 md:pb-12 md:pt-16 lg:px-12 lg:pt-16">
        <div className="flex flex-col items-center text-center">
          <Link
            className="inline-flex items-center justify-center text-[#2B2723]"
            href="/"
          >
            <span className="sr-only">Holistic Bravo home</span>
            <span
              className={`${logoClassName} text-5xl leading-none sm:text-6xl`}
            >
              Holistic Bravo
            </span>
          </Link>

          <ul className="mt-8 flex flex-wrap items-center justify-center gap-x-10 gap-y-3 text-xs font-semibold uppercase tracking-[0.25em] text-[#2B2723]/80 sm:text-sm">
            {FOOTER_LINKS.map((link) => (
              <li key={link.label}>
                {link.href.startsWith("/") ? (
                  <Link
                    className="transition hover:text-[#2B2723]"
                    href={link.href}
                  >
                    {link.label}
                  </Link>
                ) : (
                  <a
                    className="transition hover:text-[#2B2723]"
                    href={link.href}
                  >
                    {link.label}
                  </a>
                )}
             </li>
           ))}
         </ul>

          <div className="mt-8 flex justify-center">
            <SocialLinks
              wrapperClassName="flex items-center justify-center gap-4"
              itemClassName="flex h-12 w-12 items-center justify-center rounded-full bg-[#69ACC1] text-[#2B2723] transition hover:bg-[#D6E6F5]"
              iconClassName="text-[#2B2723]"
              iconSizePx={20}
            />
          </div>
        </div>

        <p className="mt-10 border-t border-[#2B2723]/10 pt-6 text-center text-sm text-[#2B2723]/70">
          © {currentYear} Holistic Bravo. All rights reserved.
        </p>
      </div>
    </footer>
  );
}
