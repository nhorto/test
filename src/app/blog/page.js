import { Suspense } from "react";

import localFont from "next/font/local";

import BlogListing from "@/components/BlogListing";
import SiteHeader from "@/components/SiteHeader";
import { client } from "@/sanity/lib/client";
import { ALL_BLOG_POSTS_QUERY } from "@/sanity/lib/queries";
import SiteFooter from "@/components/SiteFooter";

const daysOfCharity = localFont({
  src: "../../../public/DaysOfCharity-MAvZe.otf",
  display: "swap",
});

export const metadata = {
  title: "Blog - Holistic Wellness & Mindful Living Insights",
  description: "Explore holistic wellness insights, mindful living tips, healthy lifestyle advice, and personal growth stories. Join the Holistic Bravo community on a journey to balanced, intentional living.",
  openGraph: {
    title: "Blog - Holistic Wellness & Mindful Living Insights | Holistic Bravo",
    description: "Explore holistic wellness insights, mindful living tips, healthy lifestyle advice, and personal growth stories. Join the Holistic Bravo community on a journey to balanced, intentional living.",
    type: "website",
    url: "/blog",
    siteName: "Holistic Bravo",
    locale: "en_US",
  },
  twitter: {
    card: "summary_large_image",
    title: "Blog - Holistic Wellness & Mindful Living Insights",
    description: "Explore holistic wellness insights, mindful living tips, healthy lifestyle advice, and personal growth stories on the Holistic Bravo blog.",
    site: "@holisticbravo",
    creator: "@holisticbravo",
  },
  alternates: {
    canonical: "/blog",
  },
};

export default async function BlogPage() {
  const posts = await client.fetch(ALL_BLOG_POSTS_QUERY);

  return (
    <>
      <SiteHeader
        logoClassName={daysOfCharity.className}
        currentPath="/blog"
      />
      <Suspense
        fallback={
          <div className="bg-[#E6F5F2] py-16 text-center text-[#2B2723]">
            Loading blog posts…
          </div>
        }
      >
        <BlogListing
          posts={posts ?? []}
          headingFontClassName={daysOfCharity.className}
        />
      </Suspense>
      <SiteFooter logoClassName={daysOfCharity.className} />
    </>
  );
}
