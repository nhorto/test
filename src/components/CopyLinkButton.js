"use client";

import { useEffect, useState } from "react";

export default function CopyLinkButton({ className = "", iconClassName = "", iconSizePx = 22 }) {
  const [copied, setCopied] = useState(false);

  useEffect(() => {
    if (!copied) {
      return undefined;
    }

    const timeoutId = window.setTimeout(() => setCopied(false), 2000);

    return () => window.clearTimeout(timeoutId);
  }, [copied]);

  const handleCopy = async () => {
    const urlToCopy = window.location.href;

    try {
      if (navigator?.clipboard?.writeText) {
        await navigator.clipboard.writeText(urlToCopy);
        setCopied(true);
        return;
      }
    } catch (error) {
      // Fall through to manual fallback below.
    }

    const textarea = document.createElement("textarea");
    textarea.value = urlToCopy;
    textarea.setAttribute("readonly", "");
    textarea.style.position = "absolute";
    textarea.style.left = "-9999px";
    document.body.appendChild(textarea);
    textarea.select();

    try {
      document.execCommand("copy");
      setCopied(true);
    } catch (error) {
      setCopied(false);
    } finally {
      document.body.removeChild(textarea);
    }
  };

  return (
    <button
      type="button"
      onClick={handleCopy}
      className={className}
      aria-label={copied ? "Link copied" : "Copy link"}
      title={copied ? "Link copied!" : "Copy link"}
    >
      <span
        className={`lni lni-link ${iconClassName}`.trim()}
        style={{ fontSize: `${iconSizePx}px` }}
        aria-hidden="true"
      />
      <span className="sr-only">
        {copied ? "Recipe link copied to clipboard" : "Copy link to this recipe"}
      </span>
      <span aria-live="polite" className="sr-only">
        {copied ? "Copied" : ""}
      </span>
    </button>
  );
}
