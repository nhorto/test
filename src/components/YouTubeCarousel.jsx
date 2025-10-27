"use client";

import { useEffect, useRef } from "react";
import YouTubeEmbed from "./YouTubeEmbed";

export default function YouTubeCarousel({
  items = [],
  fadeColor = "#FFF6F9",
  loop = false,
}) {
  const listRef = useRef(null);
  const scrollTimeoutRef = useRef(null);
  const currentIndexRef = useRef(0);
  const transitionTimeoutRef = useRef(null);

  const isLooping = loop && items.length > 1;
  const renderedItems = isLooping
    ? [items[items.length - 1], ...items, items[0]]
    : items;

  const scrollToRenderedIndex = (index, behavior = "smooth") => {
    const container = listRef.current;
    if (!container) return;

    const slides = container.querySelectorAll("[data-slide]");
    const target = slides[index];
    if (!target) return;

    const offset = target.offsetLeft - container.offsetLeft;
    container.scrollTo({ left: offset, behavior });
  };

  useEffect(() => {
    const container = listRef.current;
    if (!container) return;

    currentIndexRef.current = isLooping ? 1 : 0;

    requestAnimationFrame(() => {
      scrollToRenderedIndex(currentIndexRef.current, "auto");
    });

    return () => {
      if (scrollTimeoutRef.current) {
        clearTimeout(scrollTimeoutRef.current);
      }
      if (transitionTimeoutRef.current) {
        clearTimeout(transitionTimeoutRef.current);
      }
    };
  }, [isLooping, renderedItems.length]);

  const handleScrollButton = (direction) => {
    const container = listRef.current;
    if (!container) return;

    const slides = container.querySelectorAll("[data-slide]");
    if (!slides.length) return;

    let nextIndex = currentIndexRef.current + direction;

    if (isLooping) {
      const minIndex = 0;
      const maxIndex = renderedItems.length - 1;

      if (nextIndex < minIndex) nextIndex = minIndex;
      if (nextIndex > maxIndex) nextIndex = maxIndex;

      scrollToRenderedIndex(nextIndex);
      currentIndexRef.current = nextIndex;

      if (nextIndex === minIndex) {
        currentIndexRef.current = renderedItems.length - 2;
        if (transitionTimeoutRef.current) {
          clearTimeout(transitionTimeoutRef.current);
        }
        transitionTimeoutRef.current = setTimeout(() => {
          scrollToRenderedIndex(renderedItems.length - 2, "auto");
          transitionTimeoutRef.current = null;
        }, 350);
      } else if (nextIndex === maxIndex) {
        currentIndexRef.current = 1;
        if (transitionTimeoutRef.current) {
          clearTimeout(transitionTimeoutRef.current);
        }
        transitionTimeoutRef.current = setTimeout(() => {
          scrollToRenderedIndex(1, "auto");
          transitionTimeoutRef.current = null;
        }, 350);
      }
    } else {
      const minIndex = 0;
      const maxIndex = renderedItems.length - 1;
      if (nextIndex < minIndex) nextIndex = minIndex;
      if (nextIndex > maxIndex) nextIndex = maxIndex;

      scrollToRenderedIndex(nextIndex);
      currentIndexRef.current = nextIndex;
    }
  };

  const handleScroll = () => {
    if (scrollTimeoutRef.current) {
      clearTimeout(scrollTimeoutRef.current);
    }

    scrollTimeoutRef.current = setTimeout(() => {
      const container = listRef.current;
      if (!container) return;

      const slides = Array.from(container.querySelectorAll("[data-slide]"));
      if (!slides.length) return;

      const { scrollLeft } = container;
      let nearestIndex = 0;
      let smallestDistance = Number.POSITIVE_INFINITY;

      slides.forEach((slide, index) => {
        const offset = slide.offsetLeft - container.offsetLeft;
        const distance = Math.abs(offset - scrollLeft);
        if (distance < smallestDistance) {
          smallestDistance = distance;
          nearestIndex = index;
        }
      });

      currentIndexRef.current = nearestIndex;

      if (isLooping) {
        const minIndex = 0;
        const maxIndex = slides.length - 1;
        if (nearestIndex === minIndex) {
          currentIndexRef.current = slides.length - 2;
          scrollToRenderedIndex(slides.length - 2, "auto");
        } else if (nearestIndex === maxIndex) {
          currentIndexRef.current = 1;
          scrollToRenderedIndex(1, "auto");
        }
      }

      scrollTimeoutRef.current = null;
    }, 120);
  };

  if (!items.length) return null;

  return (
    <div className="relative">
      <div
        ref={listRef}
        onScroll={handleScroll}
        className="flex snap-x snap-mandatory gap-6 overflow-x-auto pb-5 pl-1 pr-1 pt-1 scroll-smooth sm:pb-6"
        style={{
          scrollbarWidth: "none",
          msOverflowStyle: "none",
          scrollPaddingLeft: "1rem",
        }}
      >
        {renderedItems.map((item, index) => {
          const displayTitle = item.displayTitle || item.title;
          return (
            <article
              key={`${item.url}-${index}`}
              data-slide
              className="snap-center"
              style={{
                flex: "0 0 clamp(240px, 60vw, 320px)",
                scrollSnapAlign: "center",
              }}
            >
              <YouTubeEmbed url={item.url} title={item.title} />
              <h3 className="mt-4 text-center text-sm font-semibold text-[#2B2723] sm:text-base">
                {displayTitle}
              </h3>
            </article>
          );
        })}
      </div>

      {items.length > 1 && (
        <>
          <div
            className="pointer-events-none absolute inset-y-[10%] left-0 hidden w-16 sm:block"
            style={{
              background: `linear-gradient(90deg, ${fadeColor}, transparent)`,
            }}
          />
          <div
            className="pointer-events-none absolute inset-y-[10%] right-0 hidden w-16 sm:block"
            style={{
              background: `linear-gradient(270deg, ${fadeColor}, transparent)`,
            }}
          />

          <button
            type="button"
            onClick={() => handleScrollButton(-1)}
            className="absolute left-2 top-1/2 hidden h-12 w-12 -translate-y-1/2 items-center justify-center rounded-full bg-white/90 text-[#2B2723] shadow-lg transition hover:bg-[#69ACC1] md:flex"
            aria-label="Scroll previous videos"
          >
            <span aria-hidden="true" className="text-2xl leading-none">
              ‹
            </span>
          </button>

          <button
            type="button"
            onClick={() => handleScrollButton(1)}
            className="absolute right-2 top-1/2 hidden h-12 w-12 -translate-y-1/2 items-center justify-center rounded-full bg-white/90 text-[#2B2723] shadow-lg transition hover:bg-[#69ACC1] md:flex"
            aria-label="Scroll next videos"
          >
            <span aria-hidden="true" className="text-2xl leading-none">
              ›
            </span>
          </button>
        </>
      )}
    </div>
  );
}
