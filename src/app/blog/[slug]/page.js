import Image from "next/image";
import localFont from "next/font/local";
import Link from "next/link";
import { notFound } from "next/navigation";
import { cache } from "react";

import SiteHeader from "@/components/SiteHeader";
import PortableTextRenderer from "@/components/PortableTextRenderer";
import SocialLinks from "@/components/SocialLinks";
import CopyLinkButton from "@/components/CopyLinkButton";
import { client } from "@/sanity/lib/client";
import { BLOG_POST_BY_SLUG_QUERY } from "@/sanity/lib/queries";
import { urlFor } from "@/sanity/lib/image";
import { formatDateWithDetail } from "@/utils/content";
import SiteFooter from "@/components/SiteFooter";

const SHARE_SOCIAL_LINKS = [
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
    name: "Facebook",
    href: "https://www.facebook.com/holisticbravo",
    icon: ({ className = "", ...props }) => (
      <i
        className={`lni lni-facebook ${className}`.trim()}
        aria-hidden="true"
        {...props}
      />
    ),
  },
  {
    name: "Twitter",
    href: "https://twitter.com/holisticbravo",
    icon: ({ className = "", ...props }) => (
      <i
        className={`lni lni-twitter ${className}`.trim()}
        aria-hidden="true"
        {...props}
      />
    ),
  },
];

const daysOfCharity = localFont({
  src: "../../../../public/DaysOfCharity-MAvZe.otf",
  display: "swap",
});

const BASE_URL =
  process.env.NEXT_PUBLIC_SITE_URL ||
  (process.env.VERCEL_URL ? `https://${process.env.VERCEL_URL}` : "http://localhost:3000");

const cleanString = (value) => {
  if (typeof value !== "string") {
    return undefined;
  }

  const trimmed = value.trim();
  return trimmed.length ? trimmed : undefined;
};

const toAbsoluteUrl = (path) => {
  try {
    return new URL(path, BASE_URL).toString();
  } catch {
    return path;
  }
};

const getBlogPost = cache(async (slug) => {
  if (!slug) {
    return null;
  }

  return client.fetch(BLOG_POST_BY_SLUG_QUERY, { slug });
});

export async function generateMetadata({ params }) {
  const resolvedParams = await params;
  const slug = typeof resolvedParams?.slug === "string" ? resolvedParams.slug : undefined;

  if (!slug) {
    return {};
  }

  const post = await getBlogPost(slug);

  if (!post) {
    return {};
  }

  const title = cleanString(post.seo?.metaTitle) ?? post.title;
  const description = cleanString(post.seo?.metaDescription) ?? cleanString(post.excerpt) ?? "";
  const canonical = cleanString(post.seo?.canonicalUrl) ?? toAbsoluteUrl(`/blog/${post.slug}`);

  const shareImageSource =
    post.seo?.ogImage?.asset ? post.seo.ogImage : post.mainImage?.asset ? post.mainImage : null;
  const ogImageUrl = shareImageSource
    ? urlFor(shareImageSource).width(1200).height(630).fit("crop").url()
    : undefined;
  const ogImageAlt =
    cleanString(post.seo?.ogImage?.alt) ??
    cleanString(shareImageSource?.alt) ??
    `Featured image for ${post.title}`;

  const twitterImageSource = post.seo?.twitter?.image?.asset
    ? post.seo.twitter.image
    : shareImageSource;
  const twitterImageUrl = twitterImageSource
    ? urlFor(twitterImageSource).width(1200).height(630).fit("crop").url()
    : undefined;
  const twitterCard = post.seo?.twitter?.card ?? "summary_large_image";

  const robots = post.seo?.noindex ? { index: false, follow: true } : undefined;

  const other = {};
  if (post.publishedAt) {
    other["article:published_time"] = post.publishedAt;
  }
  if (post._updatedAt) {
    other["article:modified_time"] = post._updatedAt;
  }

  return {
    title,
    description,
    alternates: {
      canonical,
    },
    robots,
    openGraph: {
      type: "article",
      url: canonical,
      siteName: "Holistic Bravo",
      locale: "en_US",
      title,
      description,
      publishedTime: post.publishedAt ?? undefined,
      modifiedTime: post._updatedAt ?? undefined,
      images: ogImageUrl
        ? [
            {
              url: ogImageUrl,
              alt: ogImageAlt,
            },
          ]
        : undefined,
    },
    twitter: {
      card: twitterCard,
      site: "@holisticbravo",
      creator: "@holisticbravo",
      title,
      description,
      images: twitterImageUrl ? [twitterImageUrl] : undefined,
    },
    ...(Object.keys(other).length ? { other } : {}),
  };
}

function ShareStoryRow({ className = "" }) {
  return (
    <div
      className={`flex flex-wrap items-center justify-between gap-6 ${className}`.trim()}
    >
      <p className="text-xs font-semibold uppercase tracking-[0.35em] text-[#4B433C]">
        Share This Story
      </p>
      <div className="flex items-center gap-4">
        <SocialLinks
          wrapperClassName="flex items-center gap-4"
          itemClassName="flex h-12 w-12 items-center justify-center rounded-full border border-[#E6C9D4] text-[#2B2723] transition hover:bg-[#69ACC1]"
          iconClassName="text-xl"
          iconSizePx={22}
          links={SHARE_SOCIAL_LINKS}
        />
        <CopyLinkButton
          className="flex h-12 w-12 items-center justify-center rounded-full border border-[#E6C9D4] text-[#2B2723] transition hover:bg-[#69ACC1]"
          iconClassName="text-xl"
          iconSizePx={22}
        />
      </div>
    </div>
  );
}

export default async function BlogPostPage({ params }) {
  const resolvedParams = await params;
  const slug = typeof resolvedParams?.slug === "string" ? resolvedParams.slug : undefined;

  if (!slug) {
    notFound();
  }

  const post = await getBlogPost(slug);

  if (!post) {
    notFound();
  }

  const imageUrl =
    post.mainImage?.asset &&
    urlFor(post.mainImage).width(1200).height(675).fit("crop").url();
  const imageAlt = post.mainImage?.alt || `Featured image for ${post.title}`;
  const categories = Array.isArray(post.categories)
    ? post.categories.filter(Boolean)
    : [];
  const publishedLabel = formatDateWithDetail(post.publishedAt);

  // Article JSON-LD Schema
  const articleSchema = {
    "@context": "https://schema.org",
    "@type": "BlogPosting",
    headline: post.title,
    description: post.excerpt || post.seo?.metaDescription || "",
    image: imageUrl ? [imageUrl] : [],
    datePublished: post.publishedAt,
    dateModified: post._updatedAt || post.publishedAt,
    author: {
      "@type": "Person",
      name: "Holistic Bravo",
      url: BASE_URL,
    },
    publisher: {
      "@type": "Organization",
      name: "Holistic Bravo",
      logo: {
        "@type": "ImageObject",
        url: `${BASE_URL}/logo.png`,
      },
    },
    mainEntityOfPage: {
      "@type": "WebPage",
      "@id": toAbsoluteUrl(`/blog/${slug}`),
    },
    keywords: categories.join(", "),
  };

  return (
    <>
      <script
        type="application/ld+json"
        dangerouslySetInnerHTML={{ __html: JSON.stringify(articleSchema) }}
      />
      <SiteHeader
        logoClassName={daysOfCharity.className}
        currentPath={`/blog/${slug}`}
      />

      <section className="relative overflow-hidden bg-[#E6F5F2] pb-20">
        <div className="relative mx-auto max-w-6xl px-6 pt-16 lg:px-12 lg:pt-28">
          <Link
            href="/blog"
            className="inline-flex items-center text-sm font-semibold uppercase tracking-[0.3em] text-[#2B2723] transition hover:text-[#4B433C]"
          >
            <span className="mr-3 flex h-6 w-6 items-center justify-center rounded-full border border-[#2B2723]/40">
              <span className="block h-2.5 w-2.5 -rotate-45 border-b-2 border-l-2 border-[#2B2723]" />
            </span>
            Back to Blog
          </Link>

          <div className="mt-12 grid gap-12 lg:grid-cols-[minmax(0,0.85fr)_minmax(0,1.15fr)] lg:items-start lg:gap-16">
            <div className="flex flex-col gap-8 text-[#2B2723]">
              {categories.length > 0 && (
                <div className="flex flex-wrap items-center gap-3">
                  {categories.map((category) => (
                    <span
                      key={category}
                      className="rounded-full bg-[#69ACC1] px-4 py-1 text-xs font-semibold uppercase tracking-[0.25em] text-[#2B2723]"
                    >
                      {category}
                    </span>
                  ))}
                </div>
              )}

              {publishedLabel && (
                <div className="flex flex-wrap items-center gap-4 text-xs font-semibold uppercase tracking-[0.3em] text-[#8C7866]">
                  <span>{publishedLabel}</span>
                </div>
              )}

              <h1
                className={`${daysOfCharity.className} text-4xl font-normal leading-[1.1] sm:text-5xl lg:text-6xl`}
              >
                {post.title}
              </h1>

              {post.excerpt && (
                <p className="text-base leading-[1.8] text-[#4B433C] lg:max-w-xl">
                  {post.excerpt}
                </p>
              )}
            </div>

            <div className="lg:pl-6">
              {imageUrl ? (
                <div className="overflow-hidden rounded-[2.5rem] bg-white shadow-xl ring-1 ring-[#E6C9D4]/70">
                  <Image
                    src={imageUrl}
                    alt={imageAlt}
                    width={1200}
                    height={675}
                    className="h-auto w-full object-cover"
                    priority
                    sizes="(min-width: 1024px) 45rem, (min-width: 640px) 80vw, 92vw"
                  />
                </div>
              ) : (
                <div className="h-80 rounded-[2.5rem] bg-[#69ACC1]" />
              )}
            </div>
          </div>
        </div>

        <div className="relative mx-auto mt-16 max-w-4xl border-t border-[#E6C9D4]/60 px-6 pt-10">
          <ShareStoryRow />
        </div>

        <div className="relative mx-auto max-w-4xl px-6">
          <article className="mx-auto flex flex-col gap-12">
            <div className="prose prose-lg max-w-none text-[#4B433C] prose-headings:text-[#2B2723] prose-strong:text-[#2B2723] prose-a:text-[#2B2723] prose-a:underline-offset-4">
              <PortableTextRenderer value={post.body} />
            </div>

            <div className="border-t border-[#E6C9D4]/60 pt-10">
              <ShareStoryRow />
            </div>

            <div className="flex justify-center">
              <Link
                href="/blog"
                className="inline-flex items-center justify-center rounded-full bg-[#69ACC1] px-8 py-3 text-xs font-semibold uppercase tracking-[0.25em] text-[#2B2723] transition hover:bg-[#D6E6F5]"
              >
                Back to All Posts
              </Link>
            </div>
          </article>
        </div>
      </section>

      <SiteFooter logoClassName={daysOfCharity.className} />
    </>
  );
}
