// vm/weredevs/decompiler.js
'use strict';

const { LUA51_OPCODES, vmDecompileInstruction, vmTraceAnalyzer,
         buildOpcodeMapFromTrace, remapOpcodes, assignWeredevOpcodes,
         _inferOpNameFromOperands, resolveInstrConstants } = require('./opcodeMap');
const { extractWeredevConstPool, extractWeredevZAccessor,
         extractWeredevDispatchLoop, _wdEscapeRegex,
         extractVmTableNames, extractVmTable } = require('./extractor');
const { detectWeredevContext, analyzeWeredevOpcodeBlock,
         extractWeredevOperands, _buildFlatConstPool,
         resolveWeredevZCalls, detectVmDispatchLoop } = require('./interpreterParser');

function vmDecompiler(vmTrace, bytecodeDump, opcodeMap) {
  if (!vmTrace || vmTrace.length === 0)
    return { success: false, error: 'vmTraceが空', pseudoCode: '', method: 'vm_decompile' };

  const map       = (opcodeMap && opcodeMap.map) || {};
  const exMap     = (opcodeMap && opcodeMap.opcodeExecutionMap) || {};
  const catMap    = {};
  for (const [name, info] of Object.entries(exMap)) catMap[info.opcode] = info.category;

  // ── #49/#50: 定数テーブル抽出 ────────────────────────────────────────
  const constTables = {};
  for (const [tname, nums] of Object.entries(bytecodeDump || {})) {
    constTables[tname] = nums;
  }

  // ── #41: 中間命令(IR)に変換 ─────────────────────────────────────────
  const ir = [];
  // map は dispatchTable(string key) か LUA51_OPCODES(number key) を自動選択
  const resolvedMap = (map && Object.keys(map).length > 0) ? map : LUA51_OPCODES;
  for (const entry of vmTrace) {
    const { ip, op, arg1, arg2, arg3 } = entry;
    const opName = (op !== null && op !== undefined)
      ? (resolvedMap[String(op)] || resolvedMap[op] || `OP_${op}`) : 'UNKNOWN';
    const cat    = catMap[String(op)] || catMap[op] || OPCODE_CATEGORIES[opName] || 'UNKNOWN';
    ir.push({ ip, opName, cat, op, arg1, arg2, arg3 });
  }

  // ── #42: CFG構築 (IPベースの基本ブロック分割) ─────────────────────
  // leaders: IPセットを ir[0].ipから始め、全IPを登録
  const firstIp = ir.length > 0 ? ir[0].ip : 0;
  const leaders   = new Set([firstIp]);
  // 全IPをリーダー候補として追加
  for (const inst of ir) leaders.add(inst.ip);
  const jumpTargets = new Set();
  for (const inst of ir) {
    if (['JUMP','EQ','LT','LE','TEST','TESTSET'].includes(inst.cat)) {
      // JMP offset から飛び先を計算
      if (inst.opName === 'JMP' && inst.arg2 !== null) {
        const target = inst.ip + 1 + inst.arg2;
        leaders.add(target);
        jumpTargets.add(target);
      }
      leaders.add(inst.ip + 1);
    }
    if (inst.cat === 'LOOP') {
      leaders.add(inst.ip);
      if (inst.arg2 !== null) leaders.add(inst.ip + 1 + inst.arg2);
    }
  }

  // ── #43: 基本ブロック作成 ──────────────────────────────────────────
  const blocks = [];
  let currentBlock = null;
  for (const inst of ir) {
    if (leaders.has(inst.ip)) {
      if (currentBlock) blocks.push(currentBlock);
      currentBlock = { startIp: inst.ip, instructions: [], isLoopTarget: jumpTargets.has(inst.ip) };
    }
    if (currentBlock) currentBlock.instructions.push(inst);
  }
  if (currentBlock) blocks.push(currentBlock);

  // ── #44-#48: 基本ブロックから疑似Luaコード生成 ──────────────────────
  const lines = [];
  lines.push('-- ══ YAJU VM Decompiled (疑似Lua) ══');
  if (Object.keys(constTables).length > 0) {
    // #50: 定数テーブルを local const = {...} として出力
    for (const [tname, nums] of Object.entries(constTables)) {
      lines.push(`local ${tname}_const = {${nums.slice(0,16).join(',')}${nums.length > 16 ? ',...' : ''}}`);
    }
    lines.push('');
  }

  // レジスタ名マッピング (#48)
  const regName = (n) => n !== null ? `v${n}` : '_';

  let indentLevel = 0;
  const indent = () => '  '.repeat(indentLevel);
  const prevIp = { val: -1 };

  for (const block of blocks) {
    if (block.isLoopTarget)
      lines.push(`${indent()}::lbl_${block.startIp}::`);

    for (const inst of block.instructions) {
      const { ip, opName, cat, arg1, arg2, arg3 } = inst;
      let line = '';

      // #44: ジャンプ命令を if/while/for に復元
      // #45: スタック操作を変数に復元
      // #46: 算術opcode を + - * / に復元
      // #47: CALL opcode を関数呼び出しに復元
      // #48: VM register を Lua ローカル変数に変換
      switch (opName) {
        case 'MOVE':     line = `local ${regName(arg1)} = ${regName(arg2)}  -- MOVE`; break;
        case 'LOADK':    line = `local ${regName(arg1)} = K[${arg2}]  -- LOADK`; break;
        case 'LOADBOOL': line = `local ${regName(arg1)} = ${arg2 ? 'true' : 'false'}  -- LOADBOOL`; indentLevel=Math.max(0,indentLevel); break;
        case 'LOADNIL':  line = `for __i=${arg1},(${arg2}) do local _v${arg1}=nil end  -- LOADNIL`; break;
        case 'GETGLOBAL':line = `local ${regName(arg1)} = _G[K[${arg2}]]  -- GETGLOBAL`; break;
        case 'SETGLOBAL':line = `_G[K[${arg2}]] = ${regName(arg1)}  -- SETGLOBAL`; break;
        case 'GETTABLE': line = `local ${regName(arg1)} = ${regName(arg2)}[K_or_R(${arg3})]  -- GETTABLE`; break;
        case 'SETTABLE': line = `${regName(arg1)}[K_or_R(${arg2})] = K_or_R(${arg3})  -- SETTABLE`; break;
        case 'NEWTABLE': line = `local ${regName(arg1)} = {}  -- NEWTABLE`; break;
        // #46: 算術
        case 'ADD':    line = `local ${regName(arg1)} = ${regName(arg2)} + ${regName(arg3)}  -- ADD`; break;
        case 'SUB':    line = `local ${regName(arg1)} = ${regName(arg2)} - ${regName(arg3)}  -- SUB`; break;
        case 'MUL':    line = `local ${regName(arg1)} = ${regName(arg2)} * ${regName(arg3)}  -- MUL`; break;
        case 'DIV':    line = `local ${regName(arg1)} = ${regName(arg2)} / ${regName(arg3)}  -- DIV`; break;
        case 'MOD':    line = `local ${regName(arg1)} = ${regName(arg2)} % ${regName(arg3)}  -- MOD`; break;
        case 'POW':    line = `local ${regName(arg1)} = ${regName(arg2)} ^ ${regName(arg3)}  -- POW`; break;
        case 'UNM':    line = `local ${regName(arg1)} = -${regName(arg2)}  -- UNM`; break;
        case 'NOT':    line = `local ${regName(arg1)} = not ${regName(arg2)}  -- NOT`; break;
        case 'LEN':    line = `local ${regName(arg1)} = #${regName(arg2)}  -- LEN`; break;
        case 'CONCAT': {
          const parts = [];
          for (let i = arg2; i <= arg3; i++) parts.push(regName(i));
          line = `local ${regName(arg1)} = ${parts.join(' .. ')}  -- CONCAT`;
          break;
        }
        // #44: ジャンプ命令
        case 'JMP': {
          const target = ip + 1 + (arg2 || 0);
          line = `goto lbl_${target}  -- JMP target=${target}`;
          break;
        }
        case 'EQ':  line = `if (${regName(arg2)} == ${regName(arg3)}) ~= ${arg1?'true':'false'} then goto lbl_${ip+2} end  -- EQ`; break;
        case 'LT':  line = `if (${regName(arg2)} < ${regName(arg3)}) ~= ${arg1?'true':'false'} then goto lbl_${ip+2} end  -- LT`; break;
        case 'LE':  line = `if (${regName(arg2)} <= ${regName(arg3)}) ~= ${arg1?'true':'false'} then goto lbl_${ip+2} end  -- LE`; break;
        case 'TEST':    line = `if not ${regName(arg1)} then goto lbl_${ip+2} end  -- TEST`; break;
        case 'TESTSET': line = `if ${regName(arg2)} then ${regName(arg1)}=${regName(arg2)} else goto lbl_${ip+2} end  -- TESTSET`; break;
        // #47: CALL
        case 'CALL': {
          const nargs  = (arg2 || 1) - 1;
          const nret   = (arg3 || 1) - 1;
          const args_  = Array.from({length: nargs}, (_, i) => regName(arg1 + 1 + i));
          const rets   = Array.from({length: Math.max(1, nret)}, (_, i) => regName(arg1 + i));
          line = `${rets.join(', ')} = ${regName(arg1)}(${args_.join(', ')})  -- CALL`;
          break;
        }
        case 'TAILCALL': {
          const nargs_ = (arg2 || 1) - 1;
          const args__ = Array.from({length: nargs_}, (_, i) => regName(arg1 + 1 + i));
          line = `return ${regName(arg1)}(${args__.join(', ')})  -- TAILCALL`;
          break;
        }
        case 'RETURN': {
          if (!arg1 && !arg2) { line = 'return  -- RETURN'; break; }
          const nvals = (arg2 || 1) - 1;
          const vals  = Array.from({length: Math.max(1, nvals)}, (_, i) => regName((arg1||0) + i));
          line = `return ${vals.join(', ')}  -- RETURN`;
          break;
        }
        case 'FORPREP': line = `${regName(arg1)} = ${regName(arg1)} - ${regName(arg1+2)}  -- FORPREP`; indentLevel++; break;
        case 'FORLOOP': line = `${regName(arg1)} = ${regName(arg1)} + ${regName(arg1+2)}; if ${regName(arg1)} <= ${regName(arg1+1)} then goto lbl_${ip+1+(arg2||0)} end  -- FORLOOP`; indentLevel=Math.max(0,indentLevel-1); break;
        case 'CLOSURE': line = `local ${regName(arg1)} = function() --[[closure ${arg2}]] end  -- CLOSURE`; break;
        case 'SETLIST': line = `-- SETLIST ${regName(arg1)}[...]  (#${arg3})`;  break;
        case 'VARARG':  {
          const nva = (arg2 || 1) - 1;
          const vas = Array.from({length: Math.max(1,nva)}, (_, i) => regName((arg1||0)+i));
          line = `${vas.join(', ')} = ...  -- VARARG`;
          break;
        }
        default: line = `-- [ip=${ip}] ${opName}(${[arg1,arg2,arg3].filter(v=>v!==null).join(', ')})`;
      }

      lines.push(`${indent()}${line}`);
      prevIp.val = ip;
    }
  }

  lines.push('-- ══ End of Decompilation ══');
  const pseudoCode = lines.join('\n');

  // #53: decompiled.lua として保存
  let savedPath = null;
  try {
    savedPath = path.join(tempDir, `decompiled_${Date.now()}.lua`);
    fs.writeFileSync(savedPath, pseudoCode, 'utf8');
  } catch {}

  return {
    success: true,
    pseudoCode,
    instructionCount: vmTrace.length,
    blockCount: blocks.length,
    savedPath,
    method: 'vm_decompile',
  };
}

// 後方互換: reconstructedLuaBuilder → vmDecompiler に委譲
function reconstructedLuaBuilder(vmTrace, bytecodeDump, opcodeMap) {
  return vmDecompiler(vmTrace, bytecodeDump, opcodeMap);
}

// ════════════════════════════════════════════════════════════════════════
//  BLOCK W: Weredev VM 専用解析エンジン (項目 1〜10)
// ════════════════════════════════════════════════════════════════════════

// ── 項目 9: /return\s*\(\s*function/ を Weredev トリガーとして検出 ────
// vmDetector のスコアに統合し、単体でも呼べるようにエクスポート
function weredevAnalyze(code, vmTraceEntries, bTableLog, strLogEntries, options) {
  const MAX_INSTRUCTIONS = (options && options.maxInstructions) || 100000;
  const result = {
    isWeredev:      false,
    dispatchLoop:   null,
    tableNames:     [],
    tables:         {},
    escapedStrings: null,
    stringBuilder:  null,
    opcodeMap:      {},
    remapped:       {},
    decompiled:     [],
    stringsFound:   [],
    method:         'weredev_analyze',
  };

  // ── 項目 9: トリガー判定 ────────────────────────────────────────────
  result.isWeredev = isWeredevObfuscated(code);

  // ── 項目 5: dispatch ループ検出 ─────────────────────────────────────
  result.dispatchLoop = detectVmDispatchLoop(code);

  // ── 項目 1: 動的テーブル名取得 ──────────────────────────────────────
  result.tableNames = extractVmTableNames(code);

  // ── 項目 2: VMテーブル抽出 ───────────────────────────────────────────
  for (const name of result.tableNames.slice(0, 20)) {
    const tbl = extractVmTable(code, name);
    if (tbl && tbl.count >= 8) result.tables[name] = tbl;
  }

  // ── 項目 3: エスケープ文字列デコード ────────────────────────────────
  const escResult = decodeAllEscapedStrings(code);
  result.escapedStrings = { count: escResult.count, sample: escResult.result.substring(0, 200) };

  // ── 項目 8: string.char + table.concat 復号 ─────────────────────────
  result.stringBuilder = decodeStringBuilder(code);

  // ── 項目 4: opcodeMap 構築 ───────────────────────────────────────────
  const bInstructions = bTableLog && bTableLog.found ? bTableLog.instructions : [];
  const mapResult     = buildOpcodeMapFromTrace(vmTraceEntries || [], bInstructions);
  result.opcodeMap    = mapResult.opcodeMap;

  // ── 項目 10: opcode 再マッピング ─────────────────────────────────────
  const remapResult = remapOpcodes(vmTraceEntries || [], result.opcodeMap);
  result.remapped   = remapResult.remapped;
  result.remapConfidence = remapResult.confidence;

  // ── 項目 6: vmDecompileInstruction で命令列を疑似コードに変換 ─────────
  // MAX_INSTRUCTIONS ガードを適用 (項目 7)
  const traceToDecompile = (vmTraceEntries || []).slice(0, MAX_INSTRUCTIONS);
  const decompLines = [];
  decompLines.push(`-- ══ Weredev VM Decompiled (maxInstructions=${MAX_INSTRUCTIONS}) ══`);

  let prevPc = -1;
  for (const e of traceToDecompile) {
    const pc     = e.pc !== undefined ? e.pc : (e.ip || 0);
    const opcode = e.l  !== undefined ? e.l  : e.op;
    const A      = e.A  !== undefined ? e.A  : e.arg1;
    const B      = e.B  !== undefined ? e.B  : e.arg2;
    const C      = e.C  !== undefined ? e.C  : e.arg3;

    // ラベル挿入 (PC が非連続の場合)
    if (prevPc !== -1 && pc !== prevPc + 1) {
      decompLines.push(`::lbl_${pc}::`);
    }

    const lua = vmDecompileInstruction(opcode, pc, A, B, C, result.remapped);
    decompLines.push(`  -- [${pc}] ${String(opcode).padStart(3)} | ${lua}`);
    prevPc = pc;
  }

  if (traceToDecompile.length >= MAX_INSTRUCTIONS) {
    decompLines.push(`-- [WARNING] maxInstructions=${MAX_INSTRUCTIONS} に達したため出力を打ち切りました`);
  }
  decompLines.push('-- ══ End ══');
  result.decompiled     = decompLines;
  result.decompiledCode = decompLines.join('\n');

  // ── m() strlog から文字列定数を収集 ─────────────────────────────────
  if (strLogEntries && strLogEntries.length > 0) {
    result.stringsFound = strLogEntries
      .filter(e => e.val && e.val.length > 0)
      .slice(0, 200)
      .map(e => ({ idx: e.idx, val: e.val }));
  }

  return result;
}

// ────────────────────────────────────────────────────────────────────────
//  #49/#50  bytecodeテーブル抽出
// ────────────────────────────────────────────────────────────────────────
function cleanWeredevOutputCode(code, ctx) {
  if (!code) return '';
  let result = code;
  // 巨大な定数テーブル定義を圧縮 (500文字以上のリテラルテーブル)
  result = result.replace(/local\s+[A-Za-z_]\w*\s*=\s*\{[^}]{500,}\}/gs, '-- [定数プール省略]');
  // アクセサ関数定義を削除
  result = result.replace(/local\s+[A-Za-z_]\w*\s*=\s*function\s*\([^)]+\)\s*return\s+[A-Za-z_]\w*\s*\[[^\]]+\]\s*end\s*/g, '');
  result = result.replace(/\n{4,}/g, '\n\n');
  result = result.replace(/[ \t]+$/gm, '');
  return result.trim();
}

// ────────────────────────────────────────────────────────────────────────
//  疑似Luaコード組み立て
// ────────────────────────────────────────────────────────────────────────
function buildWeredevPseudoLua(analysis, ctx, originalCode) {
  const lines = [];
  lines.push('-- ════════════════════════════════════════════════════════');
  lines.push('-- Weredev VM 逆コンパイル結果 (YAJU Deobfuscator v2)');
  lines.push('-- ════════════════════════════════════════════════════════');
  lines.push('');

  // 定数プール出力
  for (const [name, pool] of Object.entries(analysis.constPools)) {
    if (pool.count === 0) continue;
    lines.push(`-- ── 定数プール: ${name} (${pool.count}要素) ────────────────────`);
    const strings = pool.elements.filter(e => e && e.type === 'string' && e.value.length > 0).slice(0, 30);
    if (strings.length > 0) {
      lines.push(`--   文字列: ${strings.map(s=>`"${s.value.substring(0,40).replace(/\n/g,'\\n')}"`).join(', ')}`);
    }
    const nums = pool.elements.filter(e => e && e.type === 'number').slice(0, 20);
    if (nums.length > 0) lines.push(`--   数値: ${nums.map(n=>String(n.value)).join(', ')}`);
  }
  if (Object.keys(analysis.constPools).length > 0) lines.push('');

  // アクセサ情報
  for (const [name, acc] of Object.entries(analysis.accessors)) {
    lines.push(`-- アクセサ: ${name}(i) = ${acc.poolName}[i - ${acc.offset}]`);
  }
  if (Object.keys(analysis.accessors).length > 0) lines.push('');

  // Z()解決サマリ
  if (analysis.stats.resolvedZCalls > 0) {
    lines.push(`-- Z()解決: ${analysis.stats.resolvedZCalls}件の定数参照を展開済み`);
    lines.push('');
  }

  // ディスパッチループ
  for (const loop of analysis.dispatchLoops) {
    lines.push(`-- VMディスパッチ: while ${loop.loopVar} do  [${loop.blockCount}ブロック]`);
  }
  if (analysis.dispatchLoops.length > 0) lines.push('');

  // opcodeブロック逆コンパイル
  if (analysis.opcodeBlocks.length > 0) {
    lines.push('-- ── opcodeブロック逆コンパイル ─────────────────────────────');
    lines.push('-- 形式: [opcode番号] OPCODE_NAME  A=レジスタ B=オペランド C=オペランド');
    lines.push('--       → vmDecompileInstruction による Lua 文');
    lines.push('');
    for (const block of analysis.opcodeBlocks) {
      const opName  = block.opName || LUA51_OPCODES[block.estimatedOpcode] || `OP_${block.estimatedOpcode}`;
      const abcInfo = [
        block.A !== null && block.A !== undefined ? `A=${block.A}` : null,
        block.B !== null && block.B !== undefined ? `B=${block.B}` : null,
        block.C !== null && block.C !== undefined ? `C=${block.C}` : null,
      ].filter(Boolean).join(' ');
      lines.push(`-- [opcode ${String(block.estimatedOpcode).padStart(2,' ')}] ${opName.padEnd(12,' ')} ${abcInfo}  (if ${ctx.loopVar} < ${block.threshold})`);
      // instrLua (vmDecompileInstruction 出力) を優先
      if (block.instrLua && !/^-- OP_|^-- UNKNOWN/.test(block.instrLua)) {
        lines.push(`  ${block.instrLua}`);
      } else {
        // フォールバック: analyzeWeredevOpcodeBlock の IRops
        for (const op of block.ops) {
          if (op.kind === 'PC_INCR' || op.kind === 'RAW') continue;
          lines.push(`  ${op.lua}`);
        }
      }
    }
    lines.push('');
  }

  // Z()解決後のクリーンアップ済みコード
  const resolvedCode = analysis.resolvedCode || originalCode;
  const cleanedCode  = cleanWeredevOutputCode(resolvedCode, ctx);
  if (cleanedCode.length > 50) {
    lines.push('-- ── Z()解決後・クリーンアップ済みコード ──────────────────────');
    lines.push(cleanedCode);
  }

  return lines.join('\n');
}

// ────────────────────────────────────────────────────────────────────────
//  メインエントリ: weredevFullDecompile
// ────────────────────────────────────────────────────────────────────────
function weredevFullDecompile(code) {
  const result = {
    success:false, method:'weredev_full_decompile',
    context:{}, constPools:{}, accessors:{}, dispatchLoops:[],
    opcodeBlocks:[], resolvedCode:'', pseudoLua:'', error:null, stats:{},
  };
  if (!code || code.length === 0) { result.error = 'コードが空です'; return result; }

  // フェーズ1: コンテキスト変数名検出
  const ctx = detectWeredevContext(code);
  result.context = ctx;

  // フェーズ2: 定数プール抽出
  const constPools = extractWeredevConstPool(code);
  result.constPools = constPools;
  result.stats.constPoolCount = Object.keys(constPools).length;
  result.stats.totalConstants = Object.values(constPools).reduce((s,p)=>s+p.count,0);

  // フェーズ3: Z() アクセサ解析
  const accessors = extractWeredevZAccessor(code, constPools);
  result.accessors = accessors;
  result.stats.accessorCount = Object.keys(accessors).length;
  // アクセサからコンテキスト更新
  if (Object.keys(accessors).length > 0) {
    const fa = Object.values(accessors)[0];
    ctx.poolVar = fa.poolName;
    ctx.zFunc   = fa.funcName;
  }

  // フェーズ4: ディスパッチループ抽出
  const loops = extractWeredevDispatchLoop(code);
  result.dispatchLoops = loops;
  result.stats.dispatchLoopCount = loops.length;
  result.stats.totalOpcodeBlocks = loops.reduce((s,l)=>s+l.blockCount,0);

  // フェーズ5: Z(N) → 定数解決 (resolvedCodeを以降の処理でも使用)
  const resolved = resolveWeredevZCalls(code, accessors, constPools);
  result.resolvedCode = resolved.code;
  result.stats.resolvedZCalls = resolved.resolved;

  // フェーズ6: opcodeブロック意味解析 + vmDecompileInstruction統合
  const allBlocks = [];
  // 定数プールを直接参照できる形にフラット化
  const flatPool = _buildFlatConstPool(constPools, accessors);

  for (const loop of loops) {
    const numbered = assignWeredevOpcodes(loop.dispatchBlocks);
    for (const block of numbered) {
      // 6a: 構造解析 (IR ops 生成)
      const ops = analyzeWeredevOpcodeBlock(block, ctx);
      // 6b: 精密オペランド抽出
      const operands = extractWeredevOperands(block.body, ctx);
      const { A, B, C } = operands;
      // 6c: オペランドパターンから実際のopNameを逆算 (Weredevのopcode番号はシャッフルされているため)
      const detectedOpName = _inferOpNameFromOperands(operands, block.body, ctx);
      const opNum = block.estimatedOpcode;
      // 6d: vmDecompileInstruction で標準Lua文を生成
      const instrLua = vmDecompileInstruction(detectedOpName, opNum, A, B, C, LUA51_OPCODES);
      // 6e: 定数参照を実際の値で置換
      const instrResolved = resolveInstrConstants(instrLua, flatPool);

      allBlocks.push({
        threshold:       block.threshold,
        estimatedOpcode: opNum,
        opName:          detectedOpName,
        A, B, C,
        instrLua:        instrResolved,
        ops,
        rawBody:         block.body.substring(0, 300),
      });
    }
  }
  result.opcodeBlocks = allBlocks;
  result.stats.opcodeBlocksDecompiled = allBlocks.length;

  // フェーズ7: 疑似Luaコード生成
  result.pseudoLua = buildWeredevPseudoLua(result, ctx, code);
  result.success = result.pseudoLua.length > 50 ||
    result.stats.totalConstants > 0 || result.stats.resolvedZCalls > 0;

  return result;
}

// ── 補助: 全定数プールをフラットな配列/マップにまとめる ──────────────────
// ── 補助: オペランドとブロック本体のパターンからopNameを推定 ─────────────
// Weredevのopcodeマッピングはランダム化されているため、
// LUA51_OPCODES[estimatedOpcode]は不正確。
// ブロック本体のパターンから正確なopNameを決定する。
function weredevFullDecompileHandler(code) {
  try {
    const r = weredevFullDecompile(code);
    const poolSummary = Object.fromEntries(
      Object.entries(r.constPools).map(([k,v]) => [k, {
        count: v.count,
        isLikelyConstPool: v.isLikelyConstPool,
        strings: v.elements.filter(e=>e&&e.type==='string').slice(0,20).map(e=>e.value.substring(0,60)),
        numbers: v.elements.filter(e=>e&&e.type==='number').slice(0,20).map(e=>e.value),
      }])
    );
    if (!r.success) {
      return {
        success:false, method:'weredev_full_decompile',
        error: r.error || 'Weredev VMパターンが検出できませんでした',
        context:r.context, stats:r.stats, constPools:poolSummary,
      };
    }
    return {
      success:true, method:'weredev_full_decompile',
      result: r.pseudoLua,
      resolvedCode: r.resolvedCode.length < 500000 ? r.resolvedCode : r.resolvedCode.substring(0,500000)+'...[truncated]',
      context:r.context, stats:r.stats, constPools:poolSummary,
      accessors:r.accessors,
      dispatchLoops: r.dispatchLoops.map(l=>({ loopVar:l.loopVar, blockCount:l.blockCount, isWhileTrue:l.isWhileTrue||false })),
      opcodeBlocks: r.opcodeBlocks.map(b=>({
        threshold:b.threshold, estimatedOpcode:b.estimatedOpcode,
        opName: LUA51_OPCODES[b.estimatedOpcode]||`OP_${b.estimatedOpcode}`,
        ops: b.ops.map(o=>o.lua),
      })),
    };
  } catch(e) {
    return { success:false, method:'weredev_full_decompile', error:'エラー: '+e.message };
  }
}

module.exports = {
  vmDecompiler, reconstructedLuaBuilder,
  weredevAnalyze, cleanWeredevOutputCode, buildWeredevPseudoLua,
  weredevFullDecompile, weredevFullDecompileHandler,
};
