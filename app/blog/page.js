import localFont from "next/font/local";

import BlogListing from "@/components/BlogListing";
import SiteHeader from "@/components/SiteHeader";
import { client } from "@/sanity/lib/client";
import { ALL_BLOG_POSTS_QUERY } from "@/sanity/lib/queries";

const daysOfCharity = localFont({
  src: "../../../public/DaysOfCharity-MAvZe.otf",
  display: "swap",
});

export default async function BlogPage() {
  const posts = await client.fetch(ALL_BLOG_POSTS_QUERY);

  return (
    <>
      <SiteHeader
        logoClassName={daysOfCharity.className}
        currentPath="/blog"
      />
      <BlogListing
        posts={posts ?? []}
        headingFontClassName={daysOfCharity.className}
      />
    </>
  );
}
