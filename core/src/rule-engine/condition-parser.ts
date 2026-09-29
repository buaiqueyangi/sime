/**
 * SIME 规则条件语言 v0 —— 编译器（词法 + 递归下降语法 → AST）
 *
 * 文法（自研内核 §4.2）：
 *   expr      := or
 *   or        := and (OR and)*
 *   and       := unary (AND unary)*
 *   unary     := NOT unary | primary
 *   primary   := '(' expr ')'
 *              | 'sequence' '(' '[' expr (',' expr)* ']' ')' 'within' duration
 *              | operand compTail?
 *   compTail  := (==|!=|>=|<=|>|<) operand | ('not')? 'in' (list | path) | 'matches' string
 *   operand   := literal | path | funcCall
 *   funcCall  := ident '(' expr (',' expr)* ')'      # count / count_distinct / time.in_shift / now
 *
 * 设计约束：不使用 eval/new Function；聚合函数只允许出现在顶层条件，
 * 不允许嵌套在 count() 参数或 sequence 步骤内（v0 限制，错误在编译期报告）。
 */

export type Node =
  | { k: 'or' | 'and'; l: Node; r: Node }
  | { k: 'not'; e: Node }
  | { k: 'cmp'; op: string; l: Node; r: Node }
  | { k: 'in'; e: Node; list: Node[]; neg: boolean }
  | { k: 'matches'; e: Node; re: RegExp }
  | { k: 'lit'; v: string | number | boolean }
  | { k: 'path'; p: string }
  | { k: 'call'; name: string; args: Node[] }
  | { k: 'seq'; steps: Node[]; withinMs: number }
  | { k: 'aggref'; i: number }; // 编译期改写产物：指向增量聚合槽位（见 rule-engine）

const DURATION = /^(\d+)([smhd])$/;
export const AGG_FUNCS = new Set(['count', 'count_distinct']);
export const PLAIN_FUNCS = new Set(['time.in_shift', 'now']);

interface Token {
  kind: 'ident' | 'num' | 'str' | 'dur' | 'op' | 'punct';
  value: string;
  pos: number;
}

export function tokenize(src: string): Token[] {
  const toks: Token[] = [];
  let i = 0;
  while (i < src.length) {
    const c = src[i];
    if (/\s/.test(c)) { i++; continue; }
    if (c === "'") {
      const end = src.indexOf("'", i + 1);
      if (end < 0) throw err('未闭合字符串', i);
      toks.push({ kind: 'str', value: src.slice(i + 1, end), pos: i });
      i = end + 1;
      continue;
    }
    if (/[0-9]/.test(c)) {
      const m = /^(\d+[smhd])|(\d+(\.\d+)?)/.exec(src.slice(i));
      if (!m) throw err('非法数字', i);
      toks.push({ kind: m[1] ? 'dur' : 'num', value: m[0], pos: i });
      i += m[0].length;
      continue;
    }
    if (/[A-Za-z_]/.test(c)) {
      const m = /^[A-Za-z_][A-Za-z0-9_]*(\.[A-Za-z_][A-Za-z0-9_]*)*/.exec(src.slice(i))!;
      toks.push({ kind: 'ident', value: m[0], pos: i });
      i += m[0].length;
      continue;
    }
    const two = src.slice(i, i + 2);
    if (['==', '!=', '>=', '<='].includes(two)) {
      toks.push({ kind: 'op', value: two, pos: i });
      i += 2;
      continue;
    }
    if ('><'.includes(c)) { toks.push({ kind: 'op', value: c, pos: i }); i++; continue; }
    if ('()[],'.includes(c)) { toks.push({ kind: 'punct', value: c, pos: i }); i++; continue; }
    throw err(`无法识别的字符 '${c}'`, i);
  }
  return toks;
}

function err(msg: string, pos: number): Error {
  return new Error(`条件语法错误 @${pos}: ${msg}`);
}

const KEYWORDS = new Set(['and', 'or', 'not', 'in', 'matches', 'within', 'sequence', 'true', 'false']);

class Parser {
  private i = 0;
  constructor(private readonly toks: Token[]) {}

  private peek(o = 0): Token | undefined { return this.toks[this.i + o]; }
  private next(): Token { const t = this.toks[this.i++]; if (!t) throw err('表达式意外结束', -1); return t; }
  private isKw(kw: string, o = 0): boolean {
    const t = this.peek(o);
    return !!t && t.kind === 'ident' && t.value.toLowerCase() === kw;
  }
  private expectPunct(p: string) {
    const t = this.next();
    if (t.kind !== 'punct' || t.value !== p) throw err(`期望 '${p}'，得到 '${t.value}'`, t.pos);
  }
  private expectKw(kw: string) {
    const t = this.next();
    if (t.kind !== 'ident' || t.value.toLowerCase() !== kw) throw err(`期望 '${kw}'，得到 '${t.value}'`, t.pos);
  }

  parseExpr(): Node { return this.parseOr(); }

  private parseOr(): Node {
    let l = this.parseAnd();
    while (this.isKw('or')) { this.next(); l = { k: 'or', l, r: this.parseAnd() }; }
    return l;
  }

  private parseAnd(): Node {
    let l = this.parseUnary();
    while (this.isKw('and')) { this.next(); l = { k: 'and', l, r: this.parseUnary() }; }
    return l;
  }

  private parseUnary(): Node {
    if (this.isKw('not') && !(this.isKw('in', 1))) {
      this.next();
      return { k: 'not', e: this.parseUnary() };
    }
    return this.parsePrimary();
  }

  private parsePrimary(): Node {
    const t = this.peek();
    if (!t) throw err('表达式意外结束', -1);
    if (t.kind === 'punct' && t.value === '(') {
      this.next();
      const e = this.parseExpr();
      this.expectPunct(')');
      return e;
    }
    if (this.isKw('sequence')) return this.parseSequence();
    const left = this.parseOperand();
    // compTail
    const t2 = this.peek();
    if (t2 && t2.kind === 'op') {
      this.next();
      const right = this.parseOperand();
      return { k: 'cmp', op: t2.value, l: left, r: right };
    }
    if (this.isKw('not') && this.isKw('in', 1)) {
      this.next(); this.next();
      return { k: 'in', e: left, list: this.parseInRhs(), neg: true };
    }
    if (this.isKw('in')) {
      this.next();
      return { k: 'in', e: left, list: this.parseInRhs(), neg: false };
    }
    if (this.isKw('matches')) {
      this.next();
      const s = this.next();
      if (s.kind !== 'str') throw err('matches 后应为正则字符串', s.pos);
      let pattern = s.value;
      let ci = false;
      if (pattern.startsWith('(?i)')) { ci = true; pattern = pattern.slice(4); }
      return { k: 'matches', e: left, re: new RegExp(pattern, ci ? 'i' : '') };
    }
    return left;
  }

  private parseInRhs(): Node[] {
    // ('a','b') 字面量列表 或 单个 path（数组字段）
    const t = this.peek()!;
    if (t.kind === 'punct' && t.value === '(') {
      this.next();
      const list: Node[] = [];
      while (true) {
        list.push(this.parseOperand());
        const n = this.next();
        if (n.kind === 'punct' && n.value === ',') continue;
        if (n.kind === 'punct' && n.value === ')') break;
        throw err('in 列表语法错误', n.pos);
      }
      return list;
    }
    const o = this.parseOperand();
    if (o.k !== 'path') throw err('in 右侧仅支持字面量列表或路径', t.pos);
    return [o];
  }

  private parseOperand(): Node {
    const t = this.next();
    if (t.kind === 'num') return { k: 'lit', v: Number(t.value) };
    if (t.kind === 'str') return { k: 'lit', v: t.value };
    if (t.kind !== 'ident') throw err(`期望操作数，得到 '${t.value}'`, t.pos);
    const low = t.value.toLowerCase();
    if (low === 'true') return { k: 'lit', v: true };
    if (low === 'false') return { k: 'lit', v: false };
    const nx = this.peek();
    if (nx && nx.kind === 'punct' && nx.value === '(') {
      this.next();
      const args: Node[] = [];
      if (!(this.peek()!.kind === 'punct' && this.peek()!.value === ')')) {
        while (true) {
          args.push(this.parseExpr());
          const n = this.next();
          if (n.kind === 'punct' && n.value === ',') continue;
          if (n.kind === 'punct' && n.value === ')') break;
          throw err('函数参数语法错误', n.pos);
        }
      } else {
        this.next();
      }
      return { k: 'call', name: low, args };
    }
    return { k: 'path', p: t.value };
  }

  private parseSequence(): Node {
    this.next(); // sequence
    this.expectPunct('(');
    this.expectPunct('[');
    const steps: Node[] = [];
    while (true) {
      steps.push(this.parseExpr());
      const n = this.next();
      if (n.kind === 'punct' && n.value === ',') continue;
      if (n.kind === 'punct' && n.value === ']') break;
      throw err('sequence 步骤语法错误', n.pos);
    }
    this.expectPunct(')');
    this.expectKw('within');
    const d = this.next();
    if (d.kind !== 'dur') throw err('within 后应为时长（如 1h）', d.pos);
    return { k: 'seq', steps, withinMs: durationMs(d.value) };
  }
}

export function durationMs(d: string): number {
  const m = DURATION.exec(d);
  if (!m) throw new Error(`非法时长: ${d}`);
  const n = Number(m[1]);
  return n * ({ s: 1000, m: 60000, h: 3600000, d: 86400000 }[m[2] as 's' | 'm' | 'h' | 'd']);
}

/** 编译 + 语义校验（函数白名单 / 聚合函数不得嵌套）。 */
export function compileCondition(src: string): Node {
  const ast = new Parser(tokenize(src)).parseExpr();
  validate(ast, false);
  return ast;
}

function validate(n: Node, insideAggOrSeq: boolean): void {
  switch (n.k) {
    case 'or': case 'and':
      validate(n.l, insideAggOrSeq); validate(n.r, insideAggOrSeq); return;
    case 'not': validate(n.e, insideAggOrSeq); return;
    case 'cmp': validate(n.l, insideAggOrSeq); validate(n.r, insideAggOrSeq); return;
    case 'in': validate(n.e, insideAggOrSeq); n.list.forEach((x) => validate(x, insideAggOrSeq)); return;
    case 'matches': validate(n.e, insideAggOrSeq); return;
    case 'call': {
      if (AGG_FUNCS.has(n.name)) {
        if (insideAggOrSeq) throw new Error(`聚合函数 ${n.name} 不允许嵌套在 count()/sequence() 内`);
        if (n.name === 'count_distinct' && (n.args.length !== 1 || n.args[0].k !== 'path'))
          throw new Error('count_distinct 参数必须是一个字段路径');
        n.args.forEach((a) => validate(a, true));
      } else if (!PLAIN_FUNCS.has(n.name)) {
        throw new Error(`未知函数 ${n.name}（v0 白名单: ${[...AGG_FUNCS, ...PLAIN_FUNCS].join(', ')}）`);
      }
      return;
    }
    case 'seq': {
      n.steps.forEach((s) => validate(s, true));
      return;
    }
    default: return; // lit/path
  }
}
