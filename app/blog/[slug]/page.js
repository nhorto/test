import Image from "next/image";
import localFont from "next/font/local";
import Link from "next/link";
import { notFound } from "next/navigation";

import PortableTextRenderer from "@/components/PortableTextRenderer";
import SiteHeader from "@/components/SiteHeader";
import { client } from "@/sanity/lib/client";
import { BLOG_POST_BY_SLUG_QUERY } from "@/sanity/lib/queries";
import { urlFor } from "@/sanity/lib/image";
import { formatDateWithDetail } from "@/utils/content";

const daysOfCharity = localFont({
  src: "../../../../public/DaysOfCharity-MAvZe.otf",
  display: "swap",
});

export default async function BlogPostPage({ params }) {
  const { slug } = params ?? {};

  if (!slug) {
    notFound();
  }

  const post = await client.fetch(BLOG_POST_BY_SLUG_QUERY, { slug });

  if (!post) {
    notFound();
  }

  const imageUrl =
    post.mainImage?.asset &&
    urlFor(post.mainImage).width(1600).height(900).fit("crop").url();
  const imageAlt = post.mainImage?.alt || `Featured image for ${post.title}`;
  const categories = Array.isArray(post.categories)
    ? post.categories.filter(Boolean)
    : [];
  const publishedLabel = formatDateWithDetail(post.publishedAt);

  return (
    <>
      <SiteHeader
        logoClassName={daysOfCharity.className}
        currentPath={`/blog/${slug}`}
      />

      <article className="bg-[#E6F5F2] pb-20">
        <div className="mx-auto flex max-w-4xl flex-col gap-10 px-6 pt-16 lg:px-12">
          <div className="flex flex-col gap-6 text-[#253C57]">
            <div className="flex flex-wrap gap-3">
              {categories.map((category) => (
                <span
                  key={category}
                  className="rounded-full bg-[#253C57] px-4 py-1 text-xs font-semibold uppercase tracking-[0.25em] text-white"
                >
                  {category}
                </span>
              ))}
            </div>

            <div>
              <h1
                className={`${daysOfCharity.className} text-4xl font-normal leading-[1.1] sm:text-5xl lg:text-6xl`}
              >
                {post.title}
              </h1>
              {publishedLabel && (
                <p className="mt-4 text-sm font-semibold uppercase tracking-[0.25em] text-[#8C7866]">
                  {publishedLabel}
                </p>
              )}
            </div>
          </div>

          {imageUrl && (
            <div className="relative aspect-[16/9] w-full overflow-hidden rounded-3xl bg-[#253C57]/10">
              <Image
                src={imageUrl}
                alt={imageAlt}
                fill
                className="object-cover"
                priority
                sizes="(min-width: 1024px) 64rem, (min-width: 640px) 80vw, 90vw"
              />
            </div>
          )}

          <div className="rounded-3xl bg-white/80 p-8 shadow-md ring-1 ring-[#253C57]/10 sm:p-10">
            <PortableTextRenderer value={post.body} />
          </div>

          <div className="flex flex-wrap items-center justify-between gap-4">
            <Link
              href="/blog"
              className="inline-flex items-center justify-center rounded-full bg-[#253C57] px-6 py-2 text-xs font-semibold uppercase tracking-[0.25em] text-white transition hover:bg-[#1C2D40]"
            >
              Back to All Posts
            </Link>
          </div>
        </div>
      </article>
    </>
  );
}
