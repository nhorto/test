import Image from "next/image";
import Link from "next/link";
import localFont from "next/font/local";

import ContentCard from "@/components/ContentCard";
import SiteHeader from "@/components/SiteHeader";
import SiteFooter from "@/components/SiteFooter";
import SocialLinks from "@/components/SocialLinks";
import YouTubeCarousel from "@/components/YouTubeCarousel";
import { client } from "@/sanity/lib/client";
import {
  LATEST_BLOG_POSTS_QUERY,
  LATEST_RECIPES_QUERY,
} from "@/sanity/lib/queries";
import { urlFor } from "@/sanity/lib/image";
import { formatDateWithDetail, getExcerptFromText, extractTextFromPortableText } from "@/utils/content";

const daysOfCharity = localFont({
  src: "../../public/DaysOfCharity-MAvZe.otf",
  display: "swap",
});

const FEATURED_VIDEOS = [
  {
    url: "https://www.youtube.com/embed/u4lOBaLE1_8",
    title:
      "ohhh the things you can do with freewill... #cooking #eggs #recipe #dailylife",
    displayTitle: "Oh, The Things You Can Do With Freewill",
  },
  {
    url: "https://www.youtube.com/embed/rrv9_NIrIK0",
    title:
      "High Protein Dessert! W/ peanut butter and chocolate #dessert #recipe #dailylife #dailyvlog",
    displayTitle: "High Protein Peanut Butter & Chocolate Dessert",
  },
  {
    url: "https://www.youtube.com/embed/y9-AEZYiNZM",
    title:
      "Carrots & Cannellini Bean Heaven ~Vegan & Plant based #cooking #recipe #dailylife",
    displayTitle: "Carrots & Cannellini Bean Heaven",
  },
  {
    url: "https://www.youtube.com/embed/Nj9nekKtiSM",
    title:
      "High Protein Bagels ~4 simple ingredients! #recipe #cooking #bagels #protein #dailylife",
    displayTitle: "High Protein Bagels (4 Ingredients)",
  },
  {
    url: "https://www.youtube.com/embed/7VR5aLXppxo",
    title:
      "Plantbased Lentil & Quinoa Stuffed Peppers #recipe #cooking #vegetarian",
    displayTitle: "Lentil & Quinoa Stuffed Peppers",
  },
  {
    url: "https://www.youtube.com/embed/AngoO10wN2g",
    title:
      "Easy Meat-free Breakfast Casserole #recipe #cooking #dailylife #vegetarian #mealprep",
    displayTitle: "Meat-Free Breakfast Casserole",
  },
  {
    url: "https://www.youtube.com/embed/L8jp1CEkxVE",
    title:
      "happy birthday to my best friend #dailylife #dailyvlog #doglife #dogmom",
    displayTitle: "Happy Birthday To My Best Friend",
  },
  {
    url: "https://www.youtube.com/embed/v3nGMCrXmqo",
    title:
      "@nespresso knew what they were doing with these fall flavors Maple Pecan & Pumpkin Spice Cake ❤️",
    displayTitle: "Nespresso Fall Favorites Taste Test",
  },
  {
    url: "https://www.youtube.com/embed/6jRtBQ0ft_8",
    title: "#dailylife #dailyvlog #motivation #vulnerability",
    displayTitle: "Daily Motivation & Vulnerability",
  },
  {
    url: "https://www.youtube.com/embed/0H1eAWXGFls",
    title:
      "High Protein + Low Calorie Matcha & Chocolate Sandwiches #dailylife #cooking #dailyvlog #recipe",
    displayTitle: "Matcha & Chocolate Protein Sandwiches",
  },
  {
    url: "https://www.youtube.com/embed/LQxWW_j-8hw",
    title: "domestic and happy #dailylife #dailyvlog #cooking #recipes",
    displayTitle: "Domestic And Happy",
  },
  {
    url: "https://www.youtube.com/embed/CafXEH91Gd8",
    title:
      "Rosemary Crackers & Fresh Hummus #hummus #mediterranean #cooking #recipe #dailyvlog",
    displayTitle: "Rosemary Crackers & Fresh Hummus",
  },
  {
    url: "https://www.youtube.com/embed/nzz3yfV35Bo",
    title:
      "homemade mushroom ravioli pasta #dailylife #dailyvlog #cooking #recipe",
    displayTitle: "Homemade Mushroom Ravioli",
  },
];

export const metadata = {
  title: "Holistic Bravo | Holistic Wellness, Vegetarian Recipes & Mindful Living",
  description: "Welcome to Holistic Bravo! Discover holistic wellness tips, delicious plant-based vegetarian and vegan recipes, mindful living practices, and inspiration for a healthier, more balanced lifestyle. Join our community of wellness warriors.",
  openGraph: {
    title: "Holistic Bravo | Holistic Wellness, Vegetarian Recipes & Mindful Living",
    description: "Welcome to Holistic Bravo! Discover holistic wellness tips, delicious plant-based vegetarian and vegan recipes, mindful living practices, and inspiration for a healthier, more balanced lifestyle.",
    type: "website",
    url: "/",
    siteName: "Holistic Bravo",
    locale: "en_US",
  },
  twitter: {
    card: "summary_large_image",
    title: "Holistic Bravo | Holistic Wellness, Vegetarian Recipes & Mindful Living",
    description: "Welcome to Holistic Bravo! Discover holistic wellness tips, delicious plant-based vegetarian and vegan recipes, mindful living practices, and inspiration for a healthier lifestyle.",
    site: "@holisticbravo",
    creator: "@holisticbravo",
  },
  alternates: {
    canonical: "/",
  },
};

export default async function HomePage() {
  const [latestBlogPosts = [], latestRecipes = []] = await Promise.all([
    client.fetch(LATEST_BLOG_POSTS_QUERY),
    client.fetch(LATEST_RECIPES_QUERY),
  ]);

  return (
    <>
      <SiteHeader logoClassName={daysOfCharity.className} currentPath="/" />

      <main>
        <section className="bg-[#EDF3FA]">
          <div className="mx-auto flex max-w-6xl flex-col items-center gap-12 px-6 py-16 lg:flex-row lg:items-center lg:px-12 lg:py-20">
            <div className="relative w-full max-w-sm shrink-0">
              <div className="relative aspect-[3/4] w-full overflow-hidden rounded-[3rem] shadow-2xl ring-1 ring-black/10">
                <Image
                  src="/face.JPG"
                  alt="Decorative mirror"
                  fill
                  priority
                  className="object-cover"
                  sizes="(min-width: 1024px) 24rem, (min-width: 640px) 45vw, 80vw"
                />
              </div>
            </div>

            <div className="flex w-full max-w-2xl flex-col items-center gap-10 text-center">
              <div className="space-y-4 text-[#2B2723]">
                <h1 className="text-4xl font-semibold tracking-tight sm:text-5xl">
                  <span className="block text-center text-base font-medium uppercase tracking-[0.5em] text-[#4B433C]">
                    Welcome to
                  </span>
                  <span className={`${daysOfCharity.className} block text-5xl font-normal leading-tight sm:text-7xl lg:text-[7rem]`}>
                    Holistic Bravo
                  </span>
                </h1>
                <p className="text-base leading-7 text-[#4B433C] sm:text-lg">
                  Hey beautiful soul! I’m Holistic Bravo—wellness warrior, spiritual hype woman, and living proof that healing is possible, growth is real, and age is just a number.
                </p>
              </div>

              <div className="flex flex-col items-center gap-4">
                <p className="text-sm uppercase tracking-[0.35em] text-[#8C7866]">Follow Me</p>
                <SocialLinks
                  wrapperClassName="flex items-center justify-center gap-5"
                  itemClassName="text-[#2B2723] transition hover:text-[#1F1B17]"
                  iconClassName="text-4xl"
                />
              </div>
            </div>
          </div>
        </section>

        <section className="bg-white">
          <div className="mx-auto max-w-6xl px-6 py-16 lg:px-12 lg:py-20">
            <div className="flex flex-col items-center gap-6 text-center text-[#2B2723]">
              <p className="text-sm font-semibold uppercase tracking-[0.35em] text-[#8C7866]">
                Shop The Essentials
              </p>
              {/* <h2
                className={`${daysOfCharity.className} text-4xl font-normal leading-tight sm:text-5xl`}
              >
                Amazon Storefront Coming Soon
              </h2>
              <p className="max-w-2xl text-base text-[#4B433C] sm:text-lg">
                I’m curating my favorite wellness, kitchen, and lifestyle finds just for you. Check back
                soon for the full storefront reveal.
              </p> */}
              <button
                type="button"
                className="inline-flex items-center justify-center rounded-full bg-[#69ACC1] px-10 py-3 text-sm font-semibold uppercase tracking-[0.25em] text-[#2B2723] shadow-sm transition hover:bg-[#D6E6F5]"
              >
                See My Amazon Storefront
              </button>
            </div>
          </div>
        </section>

        {/* About / Intro section */}
        <section className="bg-[#FFF6F9]">
          <div className="mx-auto max-w-6xl px-6 py-16 lg:px-12 lg:py-24">
            <div className="grid items-center gap-10 p-6 sm:p-10 lg:grid-cols-2 lg:gap-12">
              {/* Image (placeholder) */}
              <div className="relative order-1 aspect-[4/5] w-full overflow-hidden rounded-xl ring-1 ring-black/10 lg:order-none">
                <Image
                  src="/before.jpg"
                  alt="Before"
                  fill
                  className="object-cover animate-[fadeImagePrimary_8s_ease-in-out_infinite]"
                  sizes="(min-width: 1024px) 32rem, (min-width: 640px) 80vw, 90vw"
                  priority={false}
                />
                <Image
                  src="/miror1.JPG"
                  alt="After"
                  fill
                  className="object-cover animate-[fadeImageSecondary_8s_ease-in-out_infinite]"
                  sizes="(min-width: 1024px) 32rem, (min-width: 640px) 80vw, 90vw"
                  priority={false}
                />
              </div>

              {/* Copy */}
              <div className="space-y-4 text-[#2B2723]">
                <h2 className={`${daysOfCharity.className} text-center block text-5xl font-normal leading-tight sm:text-7xl lg:text-[7rem]`}>
                  Hi There!
                </h2>
                <div className="space-y-4 text-[#4B433C]">
                  <p>
                    I’ve been a proud vegetarian for 23 years, and at 36, most people still think I’m in my 20s (thank you, plants 🌱). Clean eating, mindful movement, and soul-deep self-care have helped me stay youthful, energized, and glowing from the inside out.But my journey hasn’t been all green smoothies and good vibes. I tore my ACL and fractured my tibial bone—a major setback that could’ve stopped me in my tracks. Instead, I chose recovery. Through physical therapy, grit, and a whole lot of exercise, I came back stronger than ever. I lost upwards of 40 pounds, rebuilt my strength, and graduated from two police academies—in my 30s.
                  </p>
                  <p>
                    I even spent nearly five years working with the Secret Service, protecting presidents while protecting my peace. Now, I channel that same discipline and drive into helping others rise, heal, and thrive.

                    This space is where holistic healing meets high performance. If you’re ready to glow up spiritually, mentally, and physically, you’re in the right place.
                  </p>
                  <p className="space-y-4 text-[#4B433C]">
                    Let’s rise, thrive, and vibe together 🌿💪✨
                  </p>
                </div>
              </div>
            </div>
          </div>
        </section>

        {/* Blog section [#E6F5F2]*/}
        <section className="bg-[#E6F5F2]"> 
          <div className="mx-auto max-w-6xl px-6 py-20 lg:px-12 lg:py-24">
            <div className="text-center text-[#2B2723]">
              <p className="text-sm font-semibold uppercase tracking-[0.35em] text-[#8C7866]">
                On The Blog
              </p>
              <h2 className={`${daysOfCharity.className} mt-4 text-4xl font-normal leading-tight sm:text-5xl`}>
                Read the Latest Stories
              </h2>
              {/* <p className="mx-auto mt-6 max-w-2xl text-base text-[#4B433C] sm:text-lg">
                Catch up on mindset shifts, wellness rituals, and soulful reflections designed to keep you aligned and
                glowing.
              </p> */}
            </div>

            <div className="mt-14 grid gap-8 sm:grid-cols-2 lg:grid-cols-3">
              {latestBlogPosts.length === 0 ? (
                <div className="col-span-full rounded-3xl bg-white/80 p-12 text-center text-[#4B433C]">
                  <p className="text-base sm:text-lg">
                    Blog posts crafted in the studio will appear here.
                  </p>
                </div>
              ) : (
                latestBlogPosts.map((post) => {
                  // Try to get description from excerpt field first
                  let descriptionText = "";
                  if (typeof post.excerpt === "string" && post.excerpt.trim()) {
                    descriptionText = post.excerpt.trim();
                  } else if (typeof post.description === "string" && post.description.trim()) {
                    descriptionText = post.description.trim();
                  } else if (post.body) {
                    // Extract text from Portable Text body
                    descriptionText = extractTextFromPortableText(post.body);
                  } else if (typeof post.seoDescription === "string" && post.seoDescription.trim()) {
                    descriptionText = post.seoDescription.trim();
                  }

                  const preview = getExcerptFromText(descriptionText) || descriptionText;

                  const href = post.slug ? `/blog/${post.slug}` : "/blog";
                  const imageUrl =
                    post.mainImage?.asset &&
                    urlFor(post.mainImage).width(600).height(450).fit("crop").url();
                  const imageAlt =
                    post.mainImage?.alt?.trim() ||
                    `Preview image for ${post.title}`;

                  return (
                    <ContentCard
                      key={post.id}
                      title={post.title}
                      description={preview || undefined}
                      href={href}
                      category={post.category}
                      meta={formatDateWithDetail(post.publishedAt)}
                      variant="blog"
                      image={imageUrl || undefined}
                      imageAlt={imageAlt}
                    />
                  );
                })
              )}
            </div>

            <div className="mt-10 flex items-center justify-center">
              <Link
                href="/blog"
                className="inline-flex items-center justify-center rounded-full bg-[#69ACC1] px-8 py-3 text-sm font-semibold uppercase tracking-[0.25em] text-[#2B2723] shadow-sm transition hover:bg-[#D6E6F5]"
              >
                View All Blog Posts
              </Link>
            </div>
          </div>
        </section>

        {/* Recipes section */}
        <section className="bg-[#FFF6F9]">
          <div className="mx-auto max-w-6xl px-6 py-20 lg:px-12 lg:py-24">
            <div className="text-center text-[#2B2723]">
              <p className="text-sm font-semibold uppercase tracking-[0.35em] text-[#8C7866]">
                In The Kitchen
              </p>
              <h2 className={`${daysOfCharity.className} mt-4 text-4xl font-normal leading-tight sm:text-5xl`}>
                Fresh From The Recipe Box
              </h2>
              {/* <p className="mx-auto mt-6 max-w-2xl text-base text-[#4B433C] sm:text-lg">
                Seasonal favorites, nourishing staples, and plant-powered plates to keep your energy high and your heart
                happy.
              </p> */}
            </div>

            <div className="mt-14 grid gap-8 sm:grid-cols-2 lg:grid-cols-3">
              {latestRecipes.length === 0 ? (
                <div className="col-span-full rounded-3xl bg-white/80 p-12 text-center text-[#4B433C]">
                  <p className="text-base sm:text-lg">
                    Fresh recipes from your editors will show up here soon.
                  </p>
                </div>
              ) : (
                latestRecipes.map((recipe) => {
                  const description =
                    typeof recipe.description === "string"
                      ? recipe.description.trim()
                      : "";

                  const href = recipe.slug ? `/recipes/${recipe.slug}` : "/recipes";
                  const imageUrl =
                    recipe.mainImage?.asset &&
                    urlFor(recipe.mainImage).width(600).height(450).fit("crop").url();
                  const imageAlt =
                    recipe.mainImage?.alt?.trim() ||
                    `Preview image for ${recipe.title}`;

                  return (
                    <ContentCard
                      key={recipe.id}
                      title={recipe.title}
                      description={description || undefined}
                      href={href}
                      category={recipe.category}
                      meta={formatDateWithDetail(recipe.publishedAt)}
                      variant="recipe"
                      image={imageUrl || undefined}
                      imageAlt={imageAlt}
                    />
                  );
                })
              )}
            </div>

            <div className="mt-10 flex items-center justify-center">
              <Link
                href="/recipes"
                className="inline-flex items-center justify-center rounded-full bg-[#69ACC1] px-8 py-3 text-sm font-semibold uppercase tracking-[0.25em] text-[#2B2723] shadow-sm transition hover:bg-[#D6E6F5]"
              >
                View All Recipes
              </Link>
            </div>
          </div>
        </section>

        <section className="bg-[#EDF3FA]">
          <div className="mx-auto max-w-6xl space-y-12 px-6 py-20 lg:px-12 lg:py-24">
            {/* <div className="text-center text-[#253C57]">
              <p className="text-sm font-semibold uppercase tracking-[0.35em] text-[#8C7866]">
                Latest Videos
              </p>
              <h2
                className={`${daysOfCharity.className} mt-4 text-4xl font-normal leading-tight sm:text-5xl`}
              >
                Press Play &amp; Get Inspired
              </h2>
              <p className="mx-auto mt-6 max-w-2xl text-base text-[#4B433C] sm:text-lg">
                Catch the newest moments from the Holistic Bravo kitchen, daily rituals, and wellness adventures—all in
                one place.
              </p>
            </div> */}

            <YouTubeCarousel items={FEATURED_VIDEOS} fadeColor="#FFF6F9" loop />
          </div>
        </section>
      </main>

      <SiteFooter logoClassName={daysOfCharity.className} />
    </>
  );
}
