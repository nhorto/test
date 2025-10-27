'use client';

import { useState } from "react";
import Link from "next/link";

import SocialLinks from "@/components/SocialLinks";

const NAV_LINKS = [
  { label: "Recipes", href: "/recipes" },
  { label: "Blog", href: "/blog" },
];

export default function SiteHeader({
  logoClassName = "",
  currentPath = "",
  logoMode = "single", // "single" keeps the logo on one line; "wrap" lets it break and header grows
}) {
  const getLinkClasses = (href) => {
    const isActive = href !== "#" && currentPath.startsWith(href);
    const base = "transition hover:text-[#2B2723]";
    const inactive = "text-[#2B2723]/70";
    const active = "text-[#2B2723]";
    return `${base} ${isActive ? active : inactive}`;
  };

  const logoTextClasses =
    logoMode === "single"
      ? "whitespace-nowrap text-2xl sm:text-3xl md:text-5xl"
      : "text-4xl sm:text-5xl md:text-6xl";

  const [isMenuOpen, setIsMenuOpen] = useState(false);

  const toggleMenu = () => {
    setIsMenuOpen((prev) => !prev);
  };

  const closeMenu = () => {
    setIsMenuOpen(false);
  };

  return (
    <header className="relative z-50 bg-white text-[#2B2723]">
      <div className="mx-auto max-w-screen-3xl px-4 sm:px-6 lg:px-8">
        <div className="flex min-h-16 items-center justify-between py-2">
          <div className="flex-1 md:flex md:items-center md:gap-12">
            <Link className="block text-[#2B2723]" href="/">
              <span className="sr-only">Home</span>
              <span
                className={`${logoClassName} ${logoTextClasses} inline-block leading-none text-[#2B2723]`}
                aria-hidden="true"
              >
                Holistic Bravo
              </span>
            </Link>
          </div>

          <div className="md:flex md:items-center md:gap-12">
            <nav aria-label="Global" className="hidden md:block">
              <ul className="flex items-center gap-6 text-sm">
                {NAV_LINKS.map((link) => (
                  <li key={link.label}>
                    <Link className={getLinkClasses(link.href)} href={link.href}>
                      {link.label}
                    </Link>
                  </li>
                ))}
              </ul>
            </nav>

            <div className="flex items-center gap-4">
              <SocialLinks
                wrapperClassName="flex items-center gap-3"
                itemClassName="flex h-10 w-10 items-center justify-center rounded-full bg-[#2B2723]/10 text-[#2B2723] transition hover:bg-[#2B2723]/20"
                iconClassName="text-[#2B2723]"
                iconSizePx={18}
              />

              <div className="block md:hidden">
                <button
                  type="button"
                  onClick={toggleMenu}
                  aria-expanded={isMenuOpen}
                  aria-controls="mobile-navigation"
                  className="rounded-sm bg-[#2B2723]/10 p-2 text-[#2B2723] transition hover:bg-[#2B2723]/20"
                >
                  <svg
                    xmlns="http://www.w3.org/2000/svg"
                    className="h-5 w-5"
                    fill="none"
                    viewBox="0 0 24 24"
                    stroke="currentColor"
                    strokeWidth="2"
                  >
                    <path
                      strokeLinecap="round"
                      strokeLinejoin="round"
                      d="M4 6h16M4 12h16M4 18h16"
                    />
                  </svg>
                  <span className="sr-only">
                    {isMenuOpen ? "Close menu" : "Open menu"}
                  </span>
                </button>
              </div>
            </div>
          </div>
        </div>
      </div>
      {isMenuOpen && (
        <>
          <div
            className="fixed inset-0 z-40 bg-black/20 md:hidden"
            aria-hidden="true"
            onClick={closeMenu}
          />
          <nav
            id="mobile-navigation"
            aria-label="Mobile navigation"
            className="absolute left-0 right-0 top-full z-50 border-t border-[#2B2723]/10 bg-white shadow-lg md:hidden"
          >
            <ul className="flex flex-col gap-1 px-4 py-4 text-base">
              {NAV_LINKS.map((link) => (
                <li key={link.label}>
                  <Link
                    className={`block rounded-md px-3 py-2 ${getLinkClasses(
                      link.href
                    )}`}
                    href={link.href}
                    onClick={closeMenu}
                  >
                    {link.label}
                  </Link>
                </li>
              ))}
            </ul>
          </nav>
        </>
      )}
    </header>
  );
}
