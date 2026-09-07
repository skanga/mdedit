(function(root, factory) {
  const api = factory();
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  if (root) root.MDEdit = Object.assign(root.MDEdit || {}, api);
})(typeof window !== 'undefined' ? window : null, () => {
  'use strict';
  function edit(start, end, text, selectionStart = start + text.length, selectionEnd = selectionStart) {
    return { start, end, text, selectionStart, selectionEnd };
  }
  function formatEdit(value, from, to, command) {
    const selected = value.slice(from, to);
    if (command.startsWith('heading-')) {
      const level = Number(command.slice(8));
      if (!Number.isInteger(level) || level < 1 || level > 6) return null;
      const start = from === 0 ? 0 : value.lastIndexOf('\n', from - 1) + 1;
      const last = to > from && value[to - 1] === '\n' ? to - 1 : to;
      let end = value.indexOf('\n', last); if (end < 0) end = value.length;
      const prefix = '#'.repeat(level) + ' ';
      const lines = value.slice(start, end).split('\n');
      const remove = lines.every(line => line.startsWith(prefix));
      const text = lines.map(line => remove ? line.slice(prefix.length) : prefix + line.replace(/^#{1,6}\s+/, '')).join('\n');
      return edit(start, end, text, start, start + text.length);
    }
    if (command === 'link') {
      const label = selected || 'link text';
      const text = '[' + label + '](https://)';
      const position = from + label.length + 3;
      return edit(from, to, text, position, position + 8);
    }
    if (command === 'code-block') {
      const ticks = [...selected.matchAll(/`+/g)].reduce((max, m) => Math.max(max, m[0].length + 1), 3);
      const fence = '`'.repeat(ticks);
      const prefix = from > 0 && value[from - 1] !== '\n' ? '\n' : '';
      const text = prefix + fence + '\n' + (selected || 'code') + '\n' + fence + (to < value.length && value[to] !== '\n' ? '\n' : '');
      const position = from + prefix.length + fence.length + 1;
      return edit(from, to, text, position, position + (selected || 'code').length);
    }
    let marker = ({bold:'**', italic:'*', code:'`'})[command];
    if (!marker) return null;
    if (command === 'code') {
      const unpad = text => text.startsWith(' ') && text.endsWith(' ') && text.trim() ? text.slice(1,-1) : text;
      const prefix = selected.match(/^`+/)?.[0], suffix = selected.match(/`+$/)?.[0];
      if (prefix && prefix === suffix && selected.length > prefix.length * 2) {
        const inner = selected.slice(prefix.length,-prefix.length);
        if (![...inner.matchAll(/`+/g)].some(run => run[0].length === prefix.length)) {
          const text=unpad(inner);return edit(from,to,text,from,from+text.length);
        }
      }
      const before = value.slice(0,from).match(/(`+)( ?)$/), after = value.slice(to).match(/^( ?)(`+)/);
      if (before && after && before[1] === after[2] && before[2] === after[1]
          && ![...selected.matchAll(/`+/g)].some(run => run[0].length === before[1].length)) {
        const start=from-before[0].length;
        return edit(start,to+after[0].length,selected,start,start+selected.length);
      }
    }
    const italicIsBold = command === 'italic' && selected.startsWith('**') && !selected.startsWith('***');
    if (command !== 'code' && !italicIsBold && selected.startsWith(marker) && selected.endsWith(marker) && selected.length >= marker.length * 2) {
      const text = selected.slice(marker.length, -marker.length);
      return edit(from, to, text, from, from + text.length);
    }
    const surroundsBold = command === 'italic' && value.slice(0,from).match(/\*+$/)?.[0].length === 2;
    if (command !== 'code' && !surroundsBold && value.slice(from - marker.length, from) === marker && value.slice(to, to + marker.length) === marker) {
      return edit(from - marker.length, to + marker.length, selected, from - marker.length, to - marker.length);
    }
    if (command === 'code') marker = '`'.repeat([...selected.matchAll(/`+/g)].reduce((max, m) => Math.max(max, m[0].length + 1), 1));
    const text = selected || (command === 'code' ? 'code' : 'text');
    const pad = command === 'code' && (text.startsWith('`') || text.endsWith('`')) ? ' ' : '';
    return edit(from, to, marker + pad + text + pad + marker, from + marker.length + pad.length, from + marker.length + pad.length + text.length);
  }

  function listEdit(value, from, to) {
    if (from !== to) return null;
    const start = from === 0 ? 0 : value.lastIndexOf('\n', from - 1) + 1;
    let fence = null;
    for (const line of value.slice(0, start).split('\n')) {
      const match = line.match(/^ {0,3}(`{3,}|~{3,})/);
      if (!match) continue;
      if (!fence) fence = match[1];
      else if (match[1][0] === fence[0] && match[1].length >= fence.length) fence = null;
    }
    if (fence) return null;
    const before = value.slice(start, from);
    const match = before.match(/^(\s*)([-+*]|\d+[.)])([ \t]+)(\[[ xX]\][ \t]+)?/);
    if (!match) return null;
    const endIndex = value.indexOf('\n', from);
    const lineEnd = endIndex < 0 ? value.length : endIndex;
    if (!value.slice(start + match[0].length, lineEnd).trim()) return edit(start, lineEnd, '');
    let marker = match[2];
    if (/^\d/.test(marker)) marker = String(Number.parseInt(marker, 10) + 1) + marker.slice(-1);
    return edit(from, to, '\n' + match[1] + marker + match[3] + (match[4] ? '[ ] ' : ''));
  }

  function searchMatches(value, query, options = {}) {
    if (!query) return {matches:[], error:null};
    try {
      let source = options.regex ? query : query.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
      if (options.wholeWord) source = '(?<![\\p{L}\\p{N}_])(?:' + source + ')(?![\\p{L}\\p{N}_])';
      const pattern = new RegExp(source, options.caseSensitive ? 'gu' : 'giu');
      const matches = [...value.matchAll(pattern)].map(match => ({start:match.index, end:match.index + match[0].length, captures:[...match], groups:match.groups}));
      return {matches, error:null};
    } catch (error) { return {matches:[], error:error.message}; }
  }

  function replacementText(value, match, regex) {
    if (!regex) return value;
    return value.replace(/\$(\$|&|\d{1,2}|<[^>]+>)/g, (token, key) => {
      if (key === '$') return '$';
      if (key === '&') return match.captures[0];
      if (key[0] === '<') return match.groups?.[key.slice(1, -1)] ?? token;
      const index = Number(key);
      if (index > 0 && index < match.captures.length) return match.captures[index] || '';
      if (key.length === 2 && Number(key[0]) > 0 && Number(key[0]) < match.captures.length) return (match.captures[Number(key[0])] || '') + key[1];
      return token;
    });
  }
  return { formatEdit, listEdit, searchMatches, replacementText };
});
