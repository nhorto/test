import Link from "next/link";

import SocialLinks from "@/components/SocialLinks";

const NAV_LINKS = [
  { label: "About Me", href: "#" },
  { label: "Recipes", href: "/recipes" },
  { label: "Blog", href: "/blog" },
];

export default function SiteHeader({
  logoClassName = "",
  currentPath = "",
}) {
  const getLinkClasses = (href) => {
    const isActive = href !== "#" && currentPath.startsWith(href);
    const base = "transition hover:text-gray-500/75";
    const inactive = "text-gray-500";
    const active = "text-[#253C57]";
    return `${base} ${isActive ? active : inactive}`;
  };

  return (
    <header className="bg-white">
      <div className="mx-auto max-w-screen-xl px-4 sm:px-6 lg:px-8">
        <div className="flex h-16 items-center justify-between">
          <div className="flex-1 md:flex md:items-center md:gap-12">
            <Link className="block text-[#253C57]" href="/">
              <span className="sr-only">Home</span>
              <span
                className={`${logoClassName} inline-block text-5xl leading-none`}
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
              <SocialLinks />

              <div className="block md:hidden">
                <button className="rounded-sm bg-gray-100 p-2 text-gray-600 transition hover:text-gray-600/75">
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
                  <span className="sr-only">Open menu</span>
                </button>
              </div>
            </div>
          </div>
        </div>
      </div>
    </header>
  );
}
