import Image from "next/image";
import localFont from "next/font/local";

import ContentCard from "@/components/ContentCard";
import SiteHeader from "@/components/SiteHeader";
import SocialLinks from "@/components/SocialLinks";
import { client } from "@/sanity/lib/client";
import {
  LATEST_BLOG_POSTS_QUERY,
  LATEST_RECIPES_QUERY,
} from "@/sanity/lib/queries";
import { formatDateWithDetail } from "@/utils/content";

const daysOfCharity = localFont({
  src: "../../public/DaysOfCharity-MAvZe.otf",
  display: "swap",
});

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
              <div className="space-y-4 text-[#253C57]">
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

        {/* About / Intro section */}
        <section className="bg-[#FFF6F9]">
          <div className="mx-auto max-w-6xl px-6 py-16 lg:px-12 lg:py-24">
            <div className="grid items-center gap-10 p-6 sm:p-10 lg:grid-cols-2 lg:gap-12">
              {/* Image (placeholder) */}
              <div className="relative order-1 aspect-[4/5] w-full overflow-hidden rounded-xl ring-1 ring-black/10 lg:order-none">
                <Image
                  src="/before.JPG"
                  alt="Before"
                  fill
                  className="object-cover animate-[fadeImagePrimary_8s_ease-in-out_infinite]"
                  sizes="(min-width: 1024px) 32rem, (min-width: 640px) 80vw, 90vw"
                  priority={false}
                />
                <Image
                  src="/miror1.jpg"
                  alt="After"
                  fill
                  className="object-cover animate-[fadeImageSecondary_8s_ease-in-out_infinite]"
                  sizes="(min-width: 1024px) 32rem, (min-width: 640px) 80vw, 90vw"
                  priority={false}
                />
              </div>

              {/* Copy */}
              <div className="space-y-4 text-[#253C57]">
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

        {/* Blog section */}
        <section className="bg-[#E6F5F2]">
          <div className="mx-auto max-w-6xl px-6 py-20 lg:px-12 lg:py-24">
            <div className="text-center text-[#253C57]">
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
                  const description =
                    typeof post.description === "string"
                      ? post.description.trim()
                      : "";

                  const href = post.slug ? `/blog/${post.slug}` : "/blog";

                  return (
                    <ContentCard
                      key={post.id}
                      title={post.title}
                      description={description || undefined}
                      href={href}
                      category={post.category}
                      meta={formatDateWithDetail(post.publishedAt)}
                      variant="blog"
                    />
                  );
                })
              )}
            </div>

            <div className="mt-10 flex items-center justify-center">
              <a
                href="/blog"
                className="inline-flex items-center justify-center rounded-full bg-[#253C57] px-8 py-3 text-sm font-semibold uppercase tracking-[0.25em] text-white shadow-sm transition hover:bg-[#1C2D40]"
              >
                View All Blog Posts
              </a>
            </div>
          </div>
        </section>

        {/* Recipes section */}
        <section className="bg-[#FFF6F9]">
          <div className="mx-auto max-w-6xl px-6 py-20 lg:px-12 lg:py-24">
            <div className="text-center text-[#253C57]">
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

                  return (
                    <ContentCard
                      key={recipe.id}
                      title={recipe.title}
                      description={description || undefined}
                      href={href}
                      category={recipe.category}
                      meta={formatDateWithDetail(recipe.publishedAt)}
                      variant="recipe"
                    />
                  );
                })
              )}
            </div>

            <div className="mt-10 flex items-center justify-center">
              <a
                href="/recipes"
                className="inline-flex items-center justify-center rounded-full bg-[#253C57] px-8 py-3 text-sm font-semibold uppercase tracking-[0.25em] text-white shadow-sm transition hover:bg-[#1C2D40]"
              >
                View All Recipes
              </a>
            </div>
          </div>
        </section>
      </main>
    </>
  );
}
