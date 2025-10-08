import Link from "next/link";
import { PortableText } from "@portabletext/react";

const components = {
  block: {
    h2: ({ children }) => (
      <h2 className="mt-10 text-3xl font-semibold text-[#253C57]">{children}</h2>
    ),
    h3: ({ children }) => (
      <h3 className="mt-8 text-2xl font-semibold text-[#253C57]">{children}</h3>
    ),
    h4: ({ children }) => (
      <h4 className="mt-6 text-xl font-semibold text-[#253C57]">{children}</h4>
    ),
    normal: ({ children }) => (
      <p className="mt-4 text-lg leading-[1.8] text-[#4B433C]">{children}</p>
    ),
    blockquote: ({ children }) => (
      <blockquote className="mt-6 border-l-4 border-[#8C7866] bg-white/70 px-6 py-4 text-lg italic text-[#3A312C]">
        {children}
      </blockquote>
    ),
  },
  list: {
    bullet: ({ children }) => (
      <ul className="mt-4 list-disc space-y-3 pl-6 text-lg text-[#4B433C]">
        {children}
      </ul>
    ),
    number: ({ children }) => (
      <ol className="mt-4 list-decimal space-y-3 pl-6 text-lg text-[#4B433C]">
        {children}
      </ol>
    ),
  },
  marks: {
    link: ({ children, value }) => {
      const href = value?.href || "#";
      const isExternal = href.startsWith("http");
      return (
        <Link
          href={href}
          target={isExternal ? "_blank" : undefined}
          rel={isExternal ? "noopener noreferrer" : undefined}
          className="underline decoration-[#8C7866] underline-offset-4 transition hover:text-[#253C57]"
        >
          {children}
        </Link>
      );
    },
    strong: ({ children }) => (
      <strong className="font-semibold text-[#253C57]">{children}</strong>
    ),
    em: ({ children }) => <em className="italic text-[#253C57]">{children}</em>,
  },
};

export default function PortableTextRenderer({ value }) {
  if (!value) {
    return null;
  }

  return <PortableText value={value} components={components} />;
}
