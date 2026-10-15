import type { ReactNode } from 'react'

// Release notes can reach us in two shapes:
//  - GitHub's atom feed (what electron-updater reads) carries the release body
//    already rendered to HTML, e.g. "<p>Fixed the thing</p><ul><li>…".
//  - A plain text body (e.g. a releaseNotes field in latest.yml) is Markdown.
// Both are turned into React elements here — no HTML is ever injected with
// dangerouslySetInnerHTML, so release notes can never run code in the app.

/* ------------------------------------------------------------------ HTML --- */

interface HtmlNode {
  tag: string | null
  text?: string
  href?: string
  children: HtmlNode[]
}

const VOID_TAGS = new Set(['br', 'hr'])
/** Rendered as nothing at all (their text content is dropped too). */
const DROPPED_TAGS = new Set(['script', 'style', 'iframe', 'object', 'embed', 'svg', 'img', 'video', 'audio'])

const ENTITIES: Record<string, string> = {
  amp: '&',
  lt: '<',
  gt: '>',
  quot: '"',
  apos: "'",
  nbsp: ' ',
  mdash: '—',
  ndash: '–',
  hellip: '…',
  rsquo: '’',
  lsquo: '‘',
  ldquo: '“',
  rdquo: '”',
  times: '×',
  check: '✓'
}

function decodeEntities(text: string): string {
  return text.replace(/&(#x?[0-9a-f]+|[a-z]+);/gi, (match, entity: string) => {
    if (entity.startsWith('#x') || entity.startsWith('#X')) {
      const code = Number.parseInt(entity.slice(2), 16)
      return Number.isFinite(code) ? String.fromCodePoint(code) : match
    }
    if (entity.startsWith('#')) {
      const code = Number.parseInt(entity.slice(1), 10)
      return Number.isFinite(code) ? String.fromCodePoint(code) : match
    }
    return ENTITIES[entity.toLowerCase()] ?? match
  })
}

function parseHtml(html: string): HtmlNode[] {
  const root: HtmlNode = { tag: null, children: [] }
  const stack: HtmlNode[] = [root]
  const tagPattern = /<\/?([a-z][a-z0-9]*)((?:"[^"]*"|'[^']*'|[^>])*)\/?>/gi
  let cursor = 0
  let match: RegExpExecArray | null

  const addText = (value: string): void => {
    if (!value) return
    stack[stack.length - 1].children.push({ tag: null, text: decodeEntities(value), children: [] })
  }

  while ((match = tagPattern.exec(html)) !== null) {
    addText(html.slice(cursor, match.index))
    cursor = tagPattern.lastIndex

    const tag = match[1].toLowerCase()
    if (DROPPED_TAGS.has(tag)) continue

    if (match[0].startsWith('</')) {
      for (let i = stack.length - 1; i > 0; i--) {
        if (stack[i].tag === tag) {
          stack.length = i
          break
        }
      }
      continue
    }

    const node: HtmlNode = {
      tag,
      href: /href\s*=\s*["']([^"']+)["']/i.exec(match[2] ?? '')?.[1],
      children: []
    }
    stack[stack.length - 1].children.push(node)
    if (!VOID_TAGS.has(tag) && !match[0].endsWith('/>')) stack.push(node)
  }

  addText(html.slice(cursor))
  return root.children
}

const HTML_BLOCK_TAGS = new Set(['p', 'div', 'ul', 'ol', 'li', 'h1', 'h2', 'h3', 'h4', 'h5', 'h6', 'pre', 'blockquote', 'hr', 'br', 'table'])

function renderHtmlNode(node: HtmlNode, key: string, outerBlock: boolean): ReactNode {
  if (node.tag === null) return node.text

  const children = node.children
    .map((child, index) => renderHtmlNode(child, `${key}-${index}`, outerBlock && HTML_BLOCK_TAGS.has(child.tag ?? '')))
    .filter((child) => child !== null && child !== '')

  switch (node.tag) {
    case 'br':
      return outerBlock ? <br key={key} /> : ' '
    case 'hr':
      return <div key={key} className="gradient-line my-4 h-px" />
    case 'h1':
    case 'h2':
      return (
        <h2 key={key} className="mt-5 mb-2 text-sm font-semibold tracking-tight first:mt-0">
          {children}
        </h2>
      )
    case 'h3':
    case 'h4':
    case 'h5':
    case 'h6':
      return (
        <h3 key={key} className="mt-4 mb-1.5 text-xs font-semibold uppercase tracking-[0.12em] text-muted-foreground first:mt-0">
          {children}
        </h3>
      )
    case 'p':
    case 'div':
      return (
        <p key={key} className="my-2 first:mt-0">
          {children}
        </p>
      )
    case 'ul':
    case 'ol': {
      const ordered = node.tag === 'ol'
      return (
        <ul key={key} className="my-2 list-none space-y-1.5 pl-0">
          {node.children.map((child, index) => {
            const childKey = `${key}-${index}`
            if ((child.tag ?? '') !== 'li') return renderHtmlNode(child, childKey, true)
            const inner = child.children
              .map((grandChild, grandIndex) => renderHtmlNode(grandChild, `${childKey}-${grandIndex}`, false))
              .filter((grandChild) => grandChild !== null && grandChild !== '')
            return (
              <li key={childKey} className="flex gap-2">
                {ordered ? (
                  <span className="shrink-0 tabular-nums text-muted-foreground">{index + 1}.</span>
                ) : (
                  <span className="mt-[0.45rem] h-1 w-1 shrink-0 rounded-full bg-primary/70" />
                )}
                <span className="min-w-0 flex-1">{inner}</span>
              </li>
            )
          })}
        </ul>
      )
    }
    case 'li':
      return (
        <li key={key} className="flex gap-2">
          <span className="mt-[0.45rem] h-1 w-1 shrink-0 rounded-full bg-primary/70" />
          <span className="min-w-0 flex-1">{children}</span>
        </li>
      )
    case 'pre':
      return (
        <pre key={key} className="my-3 overflow-x-auto rounded-lg border border-border/60 bg-secondary/40 p-3 font-mono text-[11px] leading-relaxed">
          <code>{children}</code>
        </pre>
      )
    case 'blockquote':
      return (
        <blockquote key={key} className="my-3 border-l-2 border-primary/40 pl-3 text-muted-foreground">
          {children}
        </blockquote>
      )
    case 'strong':
    case 'b':
      return (
        <strong key={key} className="font-semibold text-foreground">
          {children}
        </strong>
      )
    case 'em':
    case 'i':
      return (
        <em key={key} className="italic">
          {children}
        </em>
      )
    case 'code':
      return (
        <code key={key} className="rounded bg-secondary/70 px-1.5 py-0.5 font-mono text-[0.82em] text-foreground/90">
          {children}
        </code>
      )
    case 'a': {
      const href = node.href ?? ''
      if (!/^https?:\/\//i.test(href)) return <span key={key}>{children}</span>
      return (
        <a
          key={key}
          href={href}
          onClick={(event) => {
            event.preventDefault()
            void window.api.openExternal(href)
          }}
          className="text-primary underline decoration-primary/40 underline-offset-2 transition-colors hover:decoration-primary"
        >
          {children}
        </a>
      )
    }
    default:
      return <span key={key}>{children}</span>
  }
}

function HtmlNotes({ text, className }: { text: string; className?: string }): JSX.Element {
  const nodes = parseHtml(text)
  return (
    <div className={className}>
      {nodes.map((node, index) => renderHtmlNode(node, `n${index}`, HTML_BLOCK_TAGS.has(node.tag ?? '')))}
    </div>
  )
}

/* -------------------------------------------------------------- Markdown --- */

interface Block {
  type: 'h1' | 'h2' | 'h3' | 'p' | 'ul' | 'ol' | 'quote' | 'code' | 'hr'
  text?: string
  items?: string[]
}

const BULLET = /^\s*[-*+]\s+(.*)$/
const NUMBERED = /^\s*\d+[.)]\s+(.*)$/
const HEADING = /^(#{1,6})\s+(.*)$/
const RULE = /^\s*([-*_])(?:\s*\1){2,}\s*$/

function parseMarkdown(markdown: string): Block[] {
  const lines = markdown.replace(/\r\n?/g, '\n').split('\n')
  const blocks: Block[] = []
  let i = 0

  const isStart = (line: string): boolean =>
    !line.trim() ||
    HEADING.test(line) ||
    RULE.test(line) ||
    BULLET.test(line) ||
    NUMBERED.test(line) ||
    /^\s*>/.test(line) ||
    /^\s*```/.test(line)

  while (i < lines.length) {
    const line = lines[i]

    if (!line.trim()) {
      i++
      continue
    }

    if (/^\s*```/.test(line)) {
      const body: string[] = []
      i++
      while (i < lines.length && !/^\s*```/.test(lines[i])) body.push(lines[i++])
      i++
      blocks.push({ type: 'code', text: body.join('\n') })
      continue
    }

    const heading = HEADING.exec(line)
    if (heading) {
      const level = heading[1].length
      blocks.push({ type: level === 1 ? 'h1' : level === 2 ? 'h2' : 'h3', text: heading[2] })
      i++
      continue
    }

    if (RULE.test(line)) {
      blocks.push({ type: 'hr' })
      i++
      continue
    }

    if (BULLET.test(line) || NUMBERED.test(line)) {
      const numbered = NUMBERED.test(line)
      const pattern = numbered ? NUMBERED : BULLET
      const items: string[] = []
      while (i < lines.length && pattern.test(lines[i])) {
        items.push((pattern.exec(lines[i]) as RegExpExecArray)[1])
        i++
      }
      blocks.push({ type: numbered ? 'ol' : 'ul', items })
      continue
    }

    if (/^\s*>/.test(line)) {
      const quoted: string[] = []
      while (i < lines.length && /^\s*>/.test(lines[i])) quoted.push(lines[i++].replace(/^\s*>\s?/, ''))
      blocks.push({ type: 'quote', text: quoted.join(' ') })
      continue
    }

    const paragraph: string[] = [line]
    i++
    while (i < lines.length && !isStart(lines[i])) paragraph.push(lines[i++])
    blocks.push({ type: 'p', text: paragraph.join(' ').trim() })
  }

  return blocks
}

const INLINE = /(\[[^\]]+\]\([^)\s]+\))|(\*\*[^*]+\*\*)|(`[^`]+`)|(\*[^*\n]+\*)|(_[^_\n]+_)/g

function renderInline(text: string, keyPrefix: string): ReactNode[] {
  const nodes: ReactNode[] = []
  let last = 0
  let index = 0
  INLINE.lastIndex = 0
  let match: RegExpExecArray | null

  while ((match = INLINE.exec(text)) !== null) {
    if (match.index > last) nodes.push(text.slice(last, match.index))
    const token = match[0]
    const key = `${keyPrefix}-${index++}`

    if (token.startsWith('[')) {
      const link = /^\[([^\]]+)\]\(([^)\s]+)\)$/.exec(token)
      const label = link?.[1] ?? token
      const href = link?.[2] ?? ''
      nodes.push(
        /^https?:\/\//i.test(href) ? (
          <a
            key={key}
            href={href}
            onClick={(event) => {
              event.preventDefault()
              void window.api.openExternal(href)
            }}
            className="text-primary underline decoration-primary/40 underline-offset-2 transition-colors hover:decoration-primary"
          >
            {label}
          </a>
        ) : (
          <span key={key}>{label}</span>
        )
      )
    } else if (token.startsWith('**')) {
      nodes.push(
        <strong key={key} className="font-semibold text-foreground">
          {token.slice(2, -2)}
        </strong>
      )
    } else if (token.startsWith('`')) {
      nodes.push(
        <code key={key} className="rounded bg-secondary/70 px-1.5 py-0.5 font-mono text-[0.82em] text-foreground/90">
          {token.slice(1, -1)}
        </code>
      )
    } else {
      nodes.push(
        <em key={key} className="italic">
          {token.slice(1, -1)}
        </em>
      )
    }
    last = match.index + token.length
  }

  if (last < text.length) nodes.push(text.slice(last))
  return nodes
}

function MarkdownNotes({ text, className }: { text: string; className?: string }): JSX.Element {
  const blocks = parseMarkdown(text)

  return (
    <div className={className}>
      {blocks.map((block, index) => {
        const key = `b${index}`
        switch (block.type) {
          case 'h1':
          case 'h2':
            return (
              <h2 key={key} className="mt-5 mb-2 text-sm font-semibold tracking-tight first:mt-0">
                {renderInline(block.text ?? '', key)}
              </h2>
            )
          case 'h3':
            return (
              <h3 key={key} className="mt-4 mb-1.5 text-xs font-semibold uppercase tracking-[0.12em] text-muted-foreground first:mt-0">
                {renderInline(block.text ?? '', key)}
              </h3>
            )
          case 'ul':
          case 'ol':
            return (
              <ul key={key} className="my-2 list-none space-y-1.5 pl-0">
                {block.items?.map((item, itemIndex) => (
                  <li key={`${key}-${itemIndex}`} className="flex gap-2">
                    {block.type === 'ol' ? (
                      <span className="shrink-0 tabular-nums text-muted-foreground">{itemIndex + 1}.</span>
                    ) : (
                      <span className="mt-[0.45rem] h-1 w-1 shrink-0 rounded-full bg-primary/70" />
                    )}
                    <span className="min-w-0 flex-1">{renderInline(item, `${key}-${itemIndex}`)}</span>
                  </li>
                ))}
              </ul>
            )
          case 'quote':
            return (
              <blockquote key={key} className="my-3 border-l-2 border-primary/40 pl-3 text-muted-foreground">
                {renderInline(block.text ?? '', key)}
              </blockquote>
            )
          case 'code':
            return (
              <pre
                key={key}
                className="my-3 overflow-x-auto rounded-lg border border-border/60 bg-secondary/40 p-3 font-mono text-[11px] leading-relaxed"
              >
                <code>{block.text}</code>
              </pre>
            )
          case 'hr':
            return <div key={key} className="gradient-line my-4 h-px" />
          default:
            return (
              <p key={key} className="my-2 first:mt-0">
                {renderInline(block.text ?? '', key)}
              </p>
            )
        }
      })}
    </div>
  )
}

/** Renders release notes written in Markdown (GitHub) or already-rendered HTML. */
export function ReleaseNotes({ text, className }: { text: string; className?: string }): JSX.Element {
  const body = (text ?? '').trim()
  const looksLikeHtml = /<(p|div|ul|ol|li|h[1-6]|strong|em|code|pre|blockquote|br)\b/i.test(body)
  return looksLikeHtml ? (
    <HtmlNotes text={body} className={className} />
  ) : (
    <MarkdownNotes text={body} className={className} />
  )
}
