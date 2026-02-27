--[[
  YAJU True VM Obfuscator v3.0
  ─────────────────────────────────────────────────────
  luac のバイトコードを読んで独自VMインタープリタで実行する。
  loadstring/load を使わない本物のVM難読化。

  フロー:
    1. luac でソースをバイトコードにコンパイル
    2. バイトコードのProtoツリーを解析
    3. 命令コード (opcode) をシード依存でシャッフル
    4. Proto全体を難読化済みLuaテーブルとして出力
    5. Lua 5.1 VMインタープリタ (38命令対応) を生成して同梱
    6. 実行時: インタープリタが命令を1つずつ解釈実行

  luac が使えない場合:
    → 多段PRNG暗号化 + 動的loadstring解決 にフォールバック
    → その場合は loadstring を使うが定数・関数名は完全に隠蔽
]]

-- ═══════════════════════════════════════════════
--  ユーティリティ
-- ═══════════════════════════════════════════════
local function die(msg)
  io.stderr:write("VM_OBF_ERROR: " .. tostring(msg) .. "\n")
  os.exit(1)
end

-- 引数パース
local args = {...}
local input_file, output_file = nil, nil
local seed = math.random(100000, 999999)
do
  local i = 1
  while i <= #args do
    if   args[i]=="--out"  and args[i+1] then i=i+1; output_file=args[i]
    elseif args[i]=="--seed" and args[i+1] then i=i+1; seed=tonumber(args[i]) or seed
    elseif not input_file then input_file=args[i]
    end
    i=i+1
  end
end
if not input_file then die("usage: lua vm_obfuscator.lua input.lua --out out.lua") end
if not output_file then output_file=input_file:gsub("%.lua$","").."_vm.lua" end

-- ソース読み込み
local fh = io.open(input_file,"r")
if not fh then die("cannot open: "..input_file) end
local source = fh:read("*a"); fh:close()
if not source or #source==0 then die("empty input") end

-- 構文チェック
local _load = loadstring or load
local ok_syn = _load(source)
if not ok_syn then die("syntax error in input") end

-- ═══════════════════════════════════════════════
--  PRNG & 変数名 & 数値難読化
-- ═══════════════════════════════════════════════
local rng_s = seed
local function rng()
  rng_s=(rng_s*1664525+1013904223)%4294967296; return rng_s
end
local used_v={}
local function V()
  local conf={"I","l","O","Il","lI","IO","OI","lO","Ol"}
  local fill={"I","l","O","_","1","0"}
  local n
  repeat
    n=conf[(rng()%#conf)+1]
    for _=1,8+(rng()%5) do n=n..fill[(rng()%#fill)+1] end
  until not used_v[n]
  used_v[n]=true; return n
end
local function ne(n)
  if n==0 then return "0" end
  local r=rng()%3
  if r==0 then local a=(rng()%40)+2;local b=math.floor(n/a);local c=n-a*b;return("(%d*%d+%d)"):format(a,b,c)
  elseif r==1 then local o=(rng()%80)+5;return("(%d-%d)"):format(n+o,o)
  else local f=(rng()%6)+2;local q=math.floor(n/f);local c=n-f*q;return("(%d*%d+%d)"):format(f,q,c) end
end
-- 文字列をキーシフト暗号化して復号クロージャとして返す
local function hide_str(s)
  local key=(rng()%50)+3
  local enc={}
  for i=1,#s do enc[i]=ne((s:byte(i)+key+(i%5)*2)%256) end
  local vt,vr,vi=V(),V(),V()
  return("(function()local %s={%s};local %s={};for %s=1,#%s do %s[%s]=string.char((%s[%s]-%d-(%s-1)%%5*2+512)%%256)end;return table.concat(%s)end)()"):format(
    vt,table.concat(enc,","),vr,vi,vt,vr,vi,vt,vi,key,vi,vr)
end

-- ═══════════════════════════════════════════════
--  luac 実行
-- ═══════════════════════════════════════════════
local tmp_src=os.tmpname()..".lua"
local tmp_bc =os.tmpname()..".luac"
do local fw=io.open(tmp_src,"w"); fw:write(source); fw:close() end

local luac_bin=nil
for _,bin in ipairs({"luac5.1","luac","luajit"}) do
  if os.execute(bin.." -v > /dev/null 2>&1")==0 or os.execute(bin.." -v > /dev/null 2>&1")==true then
    luac_bin=bin; break
  end
end

local bytecode=nil
if luac_bin then
  if os.execute(luac_bin.." -o "..tmp_bc.." "..tmp_src.." 2>/dev/null")==0 or
     os.execute(luac_bin.." -o "..tmp_bc.." "..tmp_src.." 2>/dev/null")==true then
    local f2=io.open(tmp_bc,"rb")
    if f2 then bytecode=f2:read("*a"); f2:close() end
  end
  os.remove(tmp_bc)
end
os.remove(tmp_src)

-- ═══════════════════════════════════════════════
--  Lua 5.1 バイトコードパーサ
-- ═══════════════════════════════════════════════
local function parse_bytecode(bc)
  if not bc or #bc<12 then return nil,"too short" end
  if bc:sub(1,4)~="\27Lua" then return nil,"bad signature" end

  local pos=1
  local function B()  local b=bc:byte(pos);pos=pos+1;return b end
  local function U32()
    local a,b,c,d=B(),B(),B(),B()
    return a+b*256+c*65536+d*16777216
  end
  local function NUM()
    local bytes={}; for i=1,8 do bytes[i]=B() end
    local sign=bytes[8]>=128 and -1 or 1
    local exp=(bytes[8]%128)*16+math.floor(bytes[7]/16)
    local mant=(bytes[7]%16)*(2^48)
    for i=6,1,-1 do mant=mant+bytes[i]*(2^((i-1)*8)) end
    if exp==0 and mant==0 then return 0 end
    if exp==2047 then return sign*(1/0) end
    return sign*2^(exp-1023)*(1+mant/2^52)
  end
  local function STR()
    local len=U32(); if len==0 then return nil end
    local s=bc:sub(pos,pos+len-2); pos=pos+len; return s
  end

  local function read_proto()
    local p={}
    p.source=STR(); p.line_def=U32(); p.last_line=U32()
    p.nups=B(); p.nparams=B(); p.is_vararg=B(); p.max_stack=B()
    local ni=U32(); p.code={}
    for i=1,ni do p.code[i]=U32() end
    local nc=U32(); p.consts={}
    for i=1,nc do
      local t=B()
      if t==0 then p.consts[i]={t="nil"}
      elseif t==1 then p.consts[i]={t="bool",v=B()~=0}
      elseif t==3 then p.consts[i]={t="num",v=NUM()}
      elseif t==4 then p.consts[i]={t="str",v=STR()}
      else p.consts[i]={t="nil"} end
    end
    local np=U32(); p.protos={}
    for i=1,np do p.protos[i]=read_proto() end
    -- skip debug info
    local nuv=U32(); for _=1,nuv do STR() end
    local nli=U32(); for _=1,nli do U32() end
    local nlv=U32(); for _=1,nlv do STR();U32();U32() end
    local nup=U32(); for _=1,nup do STR() end
    return p
  end

  -- skip header (12 bytes after signature)
  pos=5
  B();B();B();B();B();B();B();B() -- version,format,endian,intsize,size_t,instrsize,numsize,integral

  local ok,result=pcall(read_proto)
  if not ok then return nil,tostring(result) end
  return result
end

-- ═══════════════════════════════════════════════
--  命令デコード / エンコード (Lua 5.1 format)
-- ═══════════════════════════════════════════════
local MAXARG_sBx = 131071  -- 2^17 - 1

local function decode_instr(ins)
  local op  = ins%64
  local a   = math.floor(ins/64)%256
  local b   = math.floor(ins/16384)%512
  local c   = math.floor(ins/8388608)%512
  local bx  = math.floor(ins/16384)%262144
  local sbx = bx-MAXARG_sBx
  return op,a,b,c,bx,sbx
end
local function encode_instr(op,a,b,c)
  return op + a*64 + b*16384 + c*8388608
end

-- ═══════════════════════════════════════════════
--  バイトコードパスに成功した場合の処理
-- ═══════════════════════════════════════════════
local proto=nil
if bytecode then
  local p,err=parse_bytecode(bytecode)
  if p then proto=p
  else io.stderr:write("VM_OBF_WARN: bytecode parse failed: "..tostring(err).."\n") end
end

if proto then
  -- opcode シャッフルマップ生成
  math.randomseed(seed)
  local op_to_code={}  -- original opcode → shuffled code
  local code_to_op={}  -- shuffled code → original opcode
  local pool={}; for i=0,37 do pool[i+1]=i end
  for i=38,2,-1 do local j=math.random(1,i); pool[i],pool[j]=pool[j],pool[i] end
  for i=0,37 do op_to_code[i]=pool[i+1]; code_to_op[pool[i+1]]=i end

  -- プロトの命令を再エンコード
  local function remap_proto(p)
    for i,ins in ipairs(p.code) do
      local op,a,b,c=decode_instr(ins)
      p.code[i]=encode_instr(op_to_code[op] or op,a,b,c)
    end
    for _,sp in ipairs(p.protos) do remap_proto(sp) end
  end
  remap_proto(proto)

  -- プロトをLuaテーブルにシリアライズ
  local function serial(p)
    -- 定数
    local kp={}
    for _,c in ipairs(p.consts) do
      if     c.t=="nil"  then kp[#kp+1]="nil"
      elseif c.t=="bool" then kp[#kp+1]=(c.v and "true" or "false")
      elseif c.t=="num"  then
        local n=c.v
        if n==math.floor(n) and math.abs(n)<1e12 then kp[#kp+1]=ne(math.floor(n))
        else kp[#kp+1]=tostring(n) end
      elseif c.t=="str"  then kp[#kp+1]=hide_str(c.v)
      else kp[#kp+1]="nil" end
    end
    -- 命令 (各命令をa,b,c,bxの4値に分解)
    local cp={}
    for _,ins in ipairs(p.code) do
      local op,a,b,c,bx=decode_instr(ins)
      cp[#cp+1]=("{%s,%s,%s,%s,%s}"):format(ne(op),ne(a),ne(b),ne(c),ne(bx))
    end
    -- サブプロト
    local pp={}
    for _,sp in ipairs(p.protos) do pp[#pp+1]=serial(sp) end
    return ("{k={%s},c={%s},p={%s},np=%s,ms=%s,va=%s}"):format(
      table.concat(kp,","),
      table.concat(cp,","),
      table.concat(pp,","),
      ne(p.nparams),ne(p.max_stack),ne(p.is_vararg))
  end

  local proto_str=serial(proto)

  -- code_to_op テーブルの難読化
  local unmap_parts={}
  for k,v in pairs(code_to_op) do
    unmap_parts[#unmap_parts+1]=("[%s]=%s"):format(ne(k),ne(v))
  end
  local unmap_str="{"..table.concat(unmap_parts,",").."}"

  -- ── VMコード生成 (文字列連結方式) ──────────────────────
  -- 変数名
  local vUM  =V() -- unmap table
  local vPR  =V() -- proto data
  local vVM  =V() -- VM関数
  local vF   =V() -- frame (proto)
  local vR   =V() -- registers
  local vK   =V() -- constants
  local vEnv =V() -- environment
  local vPC  =V() -- program counter
  local vIns =V() -- current instruction
  local vOP  =V() -- opcode (after unmap)
  local vA   =V(); local vB2=V(); local vC2=V(); local vBx=V()
  local vRK  =V() -- RK helper function

  -- Lua 5.1 の元のopcode番号
  local LOP={
    MOVE=0,LOADK=1,LOADBOOL=2,LOADNIL=3,
    GETUPVAL=4,GETGLOBAL=5,GETTABLE=6,
    SETGLOBAL=7,SETUPVAL=8,SETTABLE=9,
    NEWTABLE=10,SELF=11,
    ADD=12,SUB=13,MUL=14,DIV=15,MOD=16,POW=17,
    UNM=18,NOT=19,LEN=20,
    CONCAT=21,JMP=22,EQ=23,LT=24,LE=25,
    TEST=26,TESTSET=27,
    CALL=28,TAILCALL=29,RETURN=30,
    FORLOOP=31,FORPREP=32,
    TFORLOOP=33,SETLIST=34,
    CLOSE=35,CLOSURE=36,VARARG=37,
  }

  -- opcode番号を難読化した数値式で返す
  local function oc(name) return ne(LOP[name]) end

  -- コードを行ごとにテーブルで組み立て
  local lines={}
  local function L(s) lines[#lines+1]=s end

  L("(function()")
  L(("local %s=%s"):format(vUM, unmap_str))
  L(("local %s=%s"):format(vPR, proto_str))
  L(("local %s"):format(vVM))
  L(("%s=function(%s,%s,%s)"):format(vVM,vF,vR,vEnv))
  L(("  local %s=%s or _G"):format(vEnv,vEnv))
  L(("  local %s=%s or {}"):format(vR,vR))
  L(("  local %s=%s.k"):format(vK,vF))
  L(("  local %s=1"):format(vPC))
  -- RK: ISK(x) = x>=256 → 定数テーブル参照, else レジスタ
  L(("  local function %s(x) if x>=%s then return %s[x-%s] else return %s[x] end end"):format(
    vRK, ne(256), vK, ne(255), vR))
  L("  while true do")
  L(("    local %s=%s.c[%s]"):format(vIns,vF,vPC))
  L(("    if not %s then break end"):format(vIns))
  L(("    local %s=%s[%s[1]]"):format(vOP,vUM,vIns))
  L(("    local %s,%s,%s,%s=%s[2],%s[3],%s[4],%s[5]"):format(
    vA,vB2,vC2,vBx, vIns,vIns,vIns,vIns))

  -- 各opcode ハンドラ (elseif チェーン)
  -- MOVE: R(A) = R(B)
  L(("    if %s==%s then %s[%s]=%s[%s]"):format(vOP,oc("MOVE"),vR,vA,vR,vB2))
  -- LOADK: R(A) = Kst(Bx)
  L(("    elseif %s==%s then %s[%s]=%s[%s]"):format(vOP,oc("LOADK"),vR,vA,vK,vBx))
  -- LOADBOOL: R(A) = (bool)B; if C then pc++
  L(("    elseif %s==%s then %s[%s]=%s~=0;if %s~=0 then %s=%s+1 end"):format(
    vOP,oc("LOADBOOL"),vR,vA,vB2,vC2,vPC,vPC))
  -- LOADNIL: R(A..B) = nil
  L(("    elseif %s==%s then for _i=%s,%s do %s[_i]=nil end"):format(
    vOP,oc("LOADNIL"),vA,vB2,vR))
  -- GETGLOBAL: R(A) = Gbl[Kst(Bx)]
  L(("    elseif %s==%s then %s[%s]=%s[%s[%s]]"):format(
    vOP,oc("GETGLOBAL"),vR,vA,vEnv,vK,vBx))
  -- SETGLOBAL: Gbl[Kst(Bx)] = R(A)
  L(("    elseif %s==%s then %s[%s[%s]]=%s[%s]"):format(
    vOP,oc("SETGLOBAL"),vEnv,vK,vBx,vR,vA))
  -- GETTABLE: R(A) = R(B)[RK(C)]
  L(("    elseif %s==%s then %s[%s]=%s[%s][%s(%s)]"):format(
    vOP,oc("GETTABLE"),vR,vA,vR,vB2,vRK,vC2))
  -- SETTABLE: R(A)[RK(B)] = RK(C)
  L(("    elseif %s==%s then %s[%s][%s(%s)]=%s(%s)"):format(
    vOP,oc("SETTABLE"),vR,vA,vRK,vB2,vRK,vC2))
  -- NEWTABLE: R(A) = {}
  L(("    elseif %s==%s then %s[%s]={}"):format(vOP,oc("NEWTABLE"),vR,vA))
  -- SELF: R(A+1)=R(B); R(A)=R(B)[RK(C)]
  L(("    elseif %s==%s then %s[%s+1]=%s[%s];%s[%s]=%s[%s][%s(%s)]"):format(
    vOP,oc("SELF"),vR,vA,vR,vB2,vR,vA,vR,vB2,vRK,vC2))
  -- ADD
  L(("    elseif %s==%s then %s[%s]=%s(%s)+%s(%s)"):format(vOP,oc("ADD"),vR,vA,vRK,vB2,vRK,vC2))
  -- SUB
  L(("    elseif %s==%s then %s[%s]=%s(%s)-%s(%s)"):format(vOP,oc("SUB"),vR,vA,vRK,vB2,vRK,vC2))
  -- MUL
  L(("    elseif %s==%s then %s[%s]=%s(%s)*%s(%s)"):format(vOP,oc("MUL"),vR,vA,vRK,vB2,vRK,vC2))
  -- DIV
  L(("    elseif %s==%s then %s[%s]=%s(%s)/%s(%s)"):format(vOP,oc("DIV"),vR,vA,vRK,vB2,vRK,vC2))
  -- MOD
  L(("    elseif %s==%s then %s[%s]=%s(%s)%%%s(%s)"):format(vOP,oc("MOD"),vR,vA,vRK,vB2,vRK,vC2))
  -- POW
  L(("    elseif %s==%s then %s[%s]=%s(%s)^%s(%s)"):format(vOP,oc("POW"),vR,vA,vRK,vB2,vRK,vC2))
  -- UNM
  L(("    elseif %s==%s then %s[%s]=-%s[%s]"):format(vOP,oc("UNM"),vR,vA,vR,vB2))
  -- NOT
  L(("    elseif %s==%s then %s[%s]=not %s[%s]"):format(vOP,oc("NOT"),vR,vA,vR,vB2))
  -- LEN
  L(("    elseif %s==%s then %s[%s]=#%s[%s]"):format(vOP,oc("LEN"),vR,vA,vR,vB2))
  -- CONCAT: R(A) = R(B) .. ... .. R(C)
  local vTmp=V()
  L(("    elseif %s==%s then local %s={};for _i=%s,%s do %s[#%s+1]=tostring(%s[_i])end;%s[%s]=table.concat(%s)"):format(
    vOP,oc("CONCAT"),vTmp,vB2,vC2,vTmp,vTmp,vR,vR,vA,vTmp))
  -- JMP: pc += sBx  (sBx = Bx - MAXARG_sBx)
  L(("    elseif %s==%s then %s=%s+%s-%s"):format(vOP,oc("JMP"),vPC,vPC,vBx,ne(MAXARG_sBx)))
  -- EQ: if (RK(B)==RK(C)) ~= A then pc++
  L(("    elseif %s==%s then if (%s(%s)==%s(%s))~=(%s~=0) then %s=%s+1 end"):format(
    vOP,oc("EQ"),vRK,vB2,vRK,vC2,vA,vPC,vPC))
  -- LT
  L(("    elseif %s==%s then if (%s(%s)<%s(%s))~=(%s~=0) then %s=%s+1 end"):format(
    vOP,oc("LT"),vRK,vB2,vRK,vC2,vA,vPC,vPC))
  -- LE
  L(("    elseif %s==%s then if (%s(%s)<=%s(%s))~=(%s~=0) then %s=%s+1 end"):format(
    vOP,oc("LE"),vRK,vB2,vRK,vC2,vA,vPC,vPC))
  -- TEST: if (bool)R(A) ~= C then pc++
  L(("    elseif %s==%s then if (not not %s[%s])~=(%s~=0) then %s=%s+1 end"):format(
    vOP,oc("TEST"),vR,vA,vC2,vPC,vPC))
  -- TESTSET: if (bool)R(B)==C then R(A)=R(B) else pc++
  L(("    elseif %s==%s then if (not not %s[%s])==(%s~=0) then %s[%s]=%s[%s] else %s=%s+1 end"):format(
    vOP,oc("TESTSET"),vR,vB2,vC2,vR,vA,vR,vB2,vPC,vPC))
  -- CALL: R(A)..R(A+C-2) = R(A)(R(A+1)..R(A+B-1))
  local vFn=V();local vAgs=V();local vRs=V();local vNa=V();local vNr=V()
  L(("    elseif %s==%s then"):format(vOP,oc("CALL")))
  L(("      local %s=%s[%s]"):format(vFn,vR,vA))
  L(("      local %s={}"):format(vAgs))
  L(("      local %s=%s==0 and 0 or %s-1"):format(vNa,vB2,vB2))
  L(("      for _i=1,%s do %s[_i]=%s[%s+_i] end"):format(vNa,vAgs,vR,vA))
  L(("      local %s={%s(table.unpack and table.unpack(%s) or unpack(%s))}"):format(vRs,vFn,vAgs,vAgs))
  L(("      local %s=%s-1"):format(vNr,vC2))
  L(("      for _i=1,%s do %s[%s+_i-1]=%s[_i] end"):format(vNr,vR,vA,vRs))
  -- TAILCALL: return R(A)(R(A+1)..R(A+B-1))
  L(("    elseif %s==%s then"):format(vOP,oc("TAILCALL")))
  L(("      local _tfn=%s[%s];local _ta={};local _tn=%s==0 and 0 or %s-1"):format(vR,vA,vB2,vB2))
  L(("      for _i=1,_tn do _ta[_i]=%s[%s+_i] end"):format(vR,vA))
  L("      return _tfn(table.unpack and table.unpack(_ta) or unpack(_ta))")
  -- RETURN: return R(A)..R(A+B-2)
  L(("    elseif %s==%s then"):format(vOP,oc("RETURN")))
  L(("      if %s==0 then return"):format(vB2))
  L(("      elseif %s==1 then return"):format(vB2))
  L(("      else local _rv={};for _i=0,%s-2 do _rv[#_rv+1]=%s[%s+_i] end"):format(vB2,vR,vA))
  L("        return table.unpack and table.unpack(_rv) or unpack(_rv)")
  L("      end")
  -- FORLOOP: R(A)+=R(A+2); if R(A)<=R(A+1) then R(A+3)=R(A); pc+=sBx
  L(("    elseif %s==%s then"):format(vOP,oc("FORLOOP")))
  L(("      %s[%s]=%s[%s]+%s[%s+2]"):format(vR,vA,vR,vA,vR,vA))
  L(("      if (%s[%s+2]>0 and %s[%s]<=%s[%s+1]) or (%s[%s+2]<=0 and %s[%s]>=%s[%s+1]) then"):format(
    vR,vA,vR,vA,vR,vA, vR,vA,vR,vA,vR,vA))
  L(("        %s[%s+3]=%s[%s];%s=%s+%s-%s"):format(vR,vA,vR,vA,vPC,vPC,vBx,ne(MAXARG_sBx)))
  L("      end")
  -- FORPREP: R(A)-=R(A+2); pc+=sBx
  L(("    elseif %s==%s then"):format(vOP,oc("FORPREP")))
  L(("      %s[%s]=%s[%s]-%s[%s+2];%s=%s+%s-%s"):format(
    vR,vA,vR,vA,vR,vA, vPC,vPC,vBx,ne(MAXARG_sBx)))
  -- SETLIST: R(A)[Bx*FPF+i] = R(A+i) (簡易)
  L(("    elseif %s==%s then"):format(vOP,oc("SETLIST")))
  L(("      for _i=1,%s do %s[%s][_i]=%s[%s+_i] end"):format(vB2,vR,vA,vR,vA))
  -- CLOSURE: R(A) = closure(Proto[Bx])
  L(("    elseif %s==%s then"):format(vOP,oc("CLOSURE")))
  L(("      local _sp=%s.p[%s+1]"):format(vF,vBx))
  L(("      local _cur_r=%s;local _cur_env=%s"):format(vR,vEnv))
  L(("      %s[%s]=function(...)"):format(vR,vA))
  L(("        local _fr={};local _fa={...};for _i=1,#_fa do _fr[_i]=_fa[_i] end"):format())
  L(("        return %s(_sp,_fr,%s)"):format(vVM,vEnv))
  L("      end")
  -- VARARG: R(A)..R(A+B-2) = vararg (簡易: 何もしない)
  L(("    elseif %s==%s then %s[%s]=nil"):format(vOP,oc("VARARG"),vR,vA))
  -- GETUPVAL (簡易対応: upvalueはenvから取る)
  L(("    elseif %s==%s then %s[%s]=%s[%s] or nil"):format(vOP,oc("GETUPVAL"),vR,vA,vEnv,vB2))
  -- SETUPVAL
  L(("    elseif %s==%s then %s[%s]=%s[%s]"):format(vOP,oc("SETUPVAL"),vEnv,vB2,vR,vA))
  -- TFORLOOP (簡易: generalized for)
  L(("    elseif %s==%s then"):format(vOP,oc("TFORLOOP")))
  L(("      local _tf=%s[%s];local _ts=%s[%s+1];local _tv=%s[%s+2]"):format(vR,vA,vR,vA,vR,vA))
  L("      local _tr={_tf(_ts,_tv)}")
  L(("      if _tr[1]~=nil then %s[%s+2]=_tr[1];for _i=1,%s do %s[%s+2+_i]=_tr[_i] end else %s=%s+1 end"):format(
    vR,vA,vC2,vR,vA,vPC,vPC))

  L("    end")  -- end of if/elseif chain
  L(("    %s=%s+1"):format(vPC,vPC))
  L("  end")   -- end while
  L("end")     -- end function

  -- エントリポイント
  local vEntry=V()
  L(("local %s=function()%s(%s,{},_G)end"):format(vEntry,vVM,vPR))
  L(("%s()"):format(vEntry))
  L("end)()")

  local final=table.concat(lines,"\n")
  local fw2=io.open(output_file,"w")
  if not fw2 then die("cannot write: "..output_file) end
  fw2:write(final); fw2:close()
  io.write("OK:"..output_file)
  os.exit(0)
end

-- ═══════════════════════════════════════════════
--  フォールバック (luacなし)
--  多段PRNG暗号化 + チャンク分割 + 動的loadstring解決
-- ═══════════════════════════════════════════════
io.stderr:write("VM_OBF_INFO: luac unavailable, using encrypted source fallback\n")

local sa2,sb2,sc2=seed,(seed*22695477+1)%4294967296,(seed*1103515245+12345)%4294967296
local function prng2()
  sa2=(sa2*1664525+1013904223)%4294967296
  sb2=(sb2*22695477+1)%4294967296
  sc2=(sc2*1103515245+12345)%4294967296
  local v=sa2; v=v-sb2; if v<0 then v=v+4294967296 end
  return (v+sc2)%4294967296%256
end

-- ソースをチャンクに分割して個別に暗号化
local CHSZ=math.max(32,math.floor(#source/16))
local chs,cvars={},{}
local pos3=1
while pos3<=#source do
  local cd=source:sub(pos3,pos3+CHSZ-1); pos3=pos3+CHSZ
  local k3=prng2()%40+5
  local enc={}
  for i=1,#cd do enc[i]=ne((cd:byte(i)+k3+(i%7)*3)%256) end
  local vt2,vr2,vi2=V(),V(),V()
  chs[#chs+1]=("(function()local %s={%s};local %s={};for %s=1,#%s do %s[%s]=string.char((%s[%s]-%d-(%s-1)%%7*3+512)%%256)end;return table.concat(%s)end)()"):format(
    vt2,table.concat(enc,","),vr2,vi2,vt2,vr2,vi2,vt2,vi2,k3,vi2,vr2)
  cvars[#cvars+1]=V()
end

-- チャンクをシャッフル
local ord={}; for i=1,#chs do ord[i]=i end
for i=#ord,2,-1 do local j=(rng()%i)+1; ord[i],ord[j]=ord[j],ord[i] end

-- loadstringを動的解決
local lsk=(rng()%40)+5
local lse={}
for i=1,#"loadstring" do lse[i]=ne(("loadstring"):byte(i)+lsk) end
local vLt,vLr2,vLi,vLn,vLf=V(),V(),V(),V(),V()
local ls2=("local %s={%s};local %s={};for %s=1,#%s do %s[%s]=string.char(%s[%s]-%d)end;local %s=table.concat(%s);local %s=_G[%s] or load"):format(
  vLt,table.concat(lse,","),vLr2,vLi,vLt,vLr2,vLi,vLt,vLi,lsk,vLn,vLr2,vLf,vLn)

-- 元の順序に並べ直して連結
local sorted_vars={}
for i=1,#ord do sorted_vars[i]=cvars[ord[i]] end

local vSrc2=V()
local fb_lines={}
fb_lines[#fb_lines+1]="(function()"
fb_lines[#fb_lines+1]=ls2
for i=1,#chs do
  fb_lines[#fb_lines+1]=("local %s=%s"):format(cvars[i],chs[i])
end
fb_lines[#fb_lines+1]=("local %s=%s"):format(vSrc2,table.concat(sorted_vars,".."))
fb_lines[#fb_lines+1]=("%s(%s)()"):format(vLf,vSrc2)
fb_lines[#fb_lines+1]="end)()"

local fw3=io.open(output_file,"w")
if not fw3 then die("cannot write: "..output_file) end
fw3:write(table.concat(fb_lines,"\n")); fw3:close()
io.write("OK:"..output_file)
