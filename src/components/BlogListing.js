'use client';

import { useEffect, useMemo, useState } from "react";
import { usePathname, useRouter, useSearchParams } from "next/navigation";

import ContentCard from "@/components/ContentCard";
import { urlFor } from "@/sanity/lib/image";
import {
  formatDateWithDetail,
  getExcerptFromText,
  extractTextFromPortableText,
  sortByDate,
} from "@/utils/content";

const ITEMS_PER_PAGE = 6;
const SORT_OPTIONS = [
  { value: "newest", label: "Newest to Oldest" },
  { value: "oldest", label: "Oldest to Newest" },
];

const resolveCategory = (candidate, options) =>
  candidate && options.includes(candidate) ? candidate : "All";

const resolveSort = (candidate) =>
  candidate === "oldest" ? "oldest" : "newest";

const resolvePage = (candidate) => {
  const parsed = Number(candidate);
  return Number.isInteger(parsed) && parsed > 0 ? parsed : 1;
};

export default function BlogListing({
  posts = [],
  headingFontClassName = "",
}) {
  const searchParams = useSearchParams();
  const router = useRouter();
  const pathname = usePathname();

  const categoryOptions = useMemo(() => {
    const unique = Array.from(
      new Set(posts.map((post) => post.category).filter(Boolean)),
    ).sort();
    return ["All", ...unique];
  }, [posts]);

  const [selectedCategory, setSelectedCategory] = useState(() =>
    resolveCategory(searchParams.get("category"), categoryOptions),
  );
  const [sortOrder, setSortOrder] = useState(() =>
    resolveSort(searchParams.get("sort")),
  );
  const [currentPage, setCurrentPage] = useState(() =>
    resolvePage(searchParams.get("page")),
  );

  useEffect(() => {
    const nextCategory = resolveCategory(
      searchParams.get("category"),
      categoryOptions,
    );
    const nextSort = resolveSort(searchParams.get("sort"));
    const nextPage = resolvePage(searchParams.get("page"));

    setSelectedCategory(nextCategory);
    setSortOrder(nextSort);
    setCurrentPage(nextPage);
  }, [searchParams, categoryOptions]);

  useEffect(() => {
    const params = new URLSearchParams();

    if (selectedCategory !== "All") params.set("category", selectedCategory);
    if (sortOrder !== "newest") params.set("sort", sortOrder);
    if (currentPage > 1) params.set("page", String(currentPage));

    const queryString = params.toString();
    router.replace(queryString ? `${pathname}?${queryString}` : pathname, {
      scroll: false,
    });
  }, [selectedCategory, sortOrder, currentPage, pathname, router]);

  const filteredPosts = useMemo(() => {
    if (selectedCategory === "All") return posts;
    return posts.filter((post) => post.category === selectedCategory);
  }, [posts, selectedCategory]);

  const sortedPosts = useMemo(
    () =>
      sortByDate(filteredPosts, sortOrder === "newest" ? "desc" : "asc", "publishedAt"),
    [filteredPosts, sortOrder],
  );

  const totalPages = Math.max(
    1,
    Math.ceil(sortedPosts.length / ITEMS_PER_PAGE),
  );

  useEffect(() => {
    if (currentPage > totalPages) {
      setCurrentPage(totalPages);
    }
  }, [currentPage, totalPages]);

  const pageIndex = currentPage - 1;
  const start = pageIndex * ITEMS_PER_PAGE;
  const currentPosts = sortedPosts.slice(start, start + ITEMS_PER_PAGE);

  const handleCategoryClick = (category) => {
    setSelectedCategory(category);
    setCurrentPage(1);
  };

  const handleSortChange = (event) => {
    setSortOrder(event.target.value);
    setCurrentPage(1);
  };

  const handlePageChange = (page) => {
    setCurrentPage(page);
  };

  return (
    <main className="bg-[#E6F5F2]">
      <section className="mx-auto max-w-6xl px-6 py-16 lg:px-12 lg:py-20">
        <div className="text-center text-[#2B2723]">
          <p className="text-sm font-semibold uppercase tracking-[0.35em] text-[#8C7866]">
            On The Blog
          </p>
          <h1
            className={`${headingFontClassName} mt-4 text-4xl font-normal leading-tight sm:text-5xl lg:text-6xl`}
          >
            Stories for Your Rise
          </h1>
          <p className="mx-auto mt-6 max-w-2xl text-base text-[#4B433C] sm:text-lg">
            Explore reflections, mindset shifts, and rituals to support your
            healing journey. Filter by category, sort by date, and discover what
            speaks to you today.
          </p>
        </div>

        <div className="mt-12 flex flex-col gap-6 lg:flex-row lg:items-center lg:justify-between">
          <div className="flex flex-wrap gap-3">
            {categoryOptions.map((category) => {
              const isActive = category === selectedCategory;
              return (
                <button
                  key={category}
                  type="button"
                  onClick={() => handleCategoryClick(category)}
                  className={`rounded-full border px-4 py-2 text-xs font-semibold uppercase tracking-[0.25em] transition ${
                    isActive
                      ? "border-[#2B2723] bg-[#69ACC1] text-[#2B2723] shadow-lg"
                      : "border-[#2B2723]/20 bg-white/60 text-[#2B2723] hover:border-[#2B2723]/40 hover:bg-[#69ACC1]/60"
                  }`}
                >
                  {category}
                </button>
              );
            })}
          </div>

          <label className="flex items-center gap-3 text-xs font-semibold uppercase tracking-[0.35em] text-[#8C7866]">
            Sort
            <select
              value={sortOrder}
              onChange={handleSortChange}
              className="rounded-full border border-[#2B2723]/20 bg-white px-4 py-2 text-[0.75rem] tracking-[0.2em] text-[#2B2723] shadow-sm focus:border-[#2B2723] focus:outline-none focus:ring-2 focus:ring-[#2B2723]/20"
            >
              {SORT_OPTIONS.map((option) => (
                <option key={option.value} value={option.value}>
                  {option.label}
                </option>
              ))}
            </select>
          </label>
        </div>

        <div className="mt-14 grid gap-8 sm:grid-cols-2 lg:grid-cols-3">
          {currentPosts.length === 0 ? (
            <div className="col-span-full rounded-3xl bg-white/80 p-12 text-center text-[#4B433C]">
              <p className="text-base sm:text-lg">
                Nothing here just yet—check back soon for more stories in this
                category.
              </p>
            </div>
          ) : (
            currentPosts.map((post) => {
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
              const href = post.slug ? `/blog/${post.slug}` : pathname;
              const imageUrl =
                post.mainImage?.asset &&
                urlFor(post.mainImage).width(600).height(450).fit("crop").url();
              const imageAlt =
                post.mainImage?.alt?.trim() || `Preview image for ${post.title}`;

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

        {sortedPosts.length > 0 && (
          <div className="mt-12 flex flex-col items-center gap-6">
            <div className="flex items-center gap-2 text-sm font-semibold uppercase tracking-[0.2em] text-[#2B2723]">
              Page {currentPage} of {totalPages}
            </div>
            <div className="flex items-center gap-3">
              <button
                type="button"
                onClick={() => handlePageChange(Math.max(1, currentPage - 1))}
                disabled={currentPage === 1}
                className="rounded-full border border-[#2B2723]/20 bg-white px-4 py-2 text-xs font-semibold uppercase tracking-[0.25em] text-[#2B2723] transition enabled:hover:border-[#2B2723]/40 enabled:hover:bg-[#69ACC1]/60 disabled:cursor-not-allowed disabled:opacity-50"
              >
                Previous
              </button>
              <div className="flex flex-wrap items-center justify-center gap-2">
                {Array.from({ length: totalPages }, (_, index) => {
                  const pageNumber = index + 1;
                  const isActive = pageNumber === currentPage;
                  return (
                    <button
                      key={pageNumber}
                      type="button"
                      onClick={() => handlePageChange(pageNumber)}
                      className={`h-10 w-10 rounded-full border text-sm font-semibold transition ${
                        isActive
                          ? "border-[#2B2723] bg-[#69ACC1] text-[#2B2723]"
                          : "border-[#2B2723]/20 bg-white text-[#2B2723] hover:border-[#2B2723]/40 hover:bg-[#69ACC1]/60"
                      }`}
                    >
                      {pageNumber}
                    </button>
                  );
                })}
              </div>
              <button
                type="button"
                onClick={() =>
                  handlePageChange(Math.min(totalPages, currentPage + 1))
                }
                disabled={currentPage === totalPages}
                className="rounded-full border border-[#2B2723]/20 bg-white px-4 py-2 text-xs font-semibold uppercase tracking-[0.25em] text-[#2B2723] transition enabled:hover:border-[#2B2723]/40 enabled:hover:bg-[#69ACC1]/60 disabled:cursor-not-allowed disabled:opacity-50"
              >
                Next
              </button>
            </div>
          </div>
        )}
      </section>
    </main>
  );
}
