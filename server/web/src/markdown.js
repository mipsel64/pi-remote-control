import { createElement as h, memo } from 'react';
import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';

const link = href => ({ href, target: '_blank', rel: 'noopener noreferrer' });
const components = {
  // In-page links (GFM footnotes) must stay in this tab and keep their ids/aria attributes.
  a: ({ node, ...props }) => h('a', props.href?.startsWith('#') ? props : { ...props, ...link(props.href) }),
  // Transcripts can quote untrusted pages; never let them load remote images.
  img: ({ node, src, alt }) => src ? h('a', link(src), alt || src) : alt || null,
  pre: ({ node, children }) => {
    const lang = /language-(\S+)/.exec(children?.props?.className ?? '')?.[1];
    return h('div', { className: 'code-block' }, h('div', { className: 'code-lang' }, lang || 'code'), h('pre', null, children));
  },
  table: ({ node, children }) => h('div', { className: 'table-wrap' }, h('table', null, children))
};

// Memoized: streaming re-renders the whole thread per token, and unchanged messages need no re-parse.
export const Markdown = memo(({ text }) =>
  h('div', { className: 'md' }, h(ReactMarkdown, { remarkPlugins: [remarkGfm], components }, String(text ?? ''))));
