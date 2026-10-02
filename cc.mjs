/**
 * Compile C - really C.
 *
 * browsercc drives its clang as "clang++", and clang++ compiles a .c file as C++. That
 * made 运行 disagree with 提交 in both directions: it accepted "for (int i = 0; ...)"
 * (an error for the judge's gcc-3.3) and it rejected an implicit conversion from void*
 * (fine in C, an error in C++). This driver runs the very same clang.wasm and wasm-ld
 * with thisProgram "clang" instead, so the language is C and a standard flag means what
 * it says.
 */
export function makeCompiler(module, sysroot) {
  const { Clang, LLD, setUpSysroot } = module;
  /** The dummy sysroot the driver needs to resolve its own paths for "-###". */
  const prepDriver = clang => {
    clang.FS.mkdirTree('/lib/wasm32-wasi');
    clang.FS.mkdirTree('/include/c++/v1');
    clang.FS.writeFile('/lib/wasm32-wasi/crt1-command.o', new Uint8Array(0));
    clang.FS.writeFile('/lib/wasm32-wasi/crt1-reactor.o', new Uint8Array(0));
  };
  /** Ask the driver what it would run, instead of reimplementing its option parsing. */
  const invocationFor = async (fileName, source, flags) => {
    const state = { err: '' };
    const clang = await Clang({ thisProgram: 'clang', printErr: data => { state.err += data + '\n'; } });
    clang.FS.writeFile(fileName, source);
    prepDriver(clang);
    if (clang.callMain([fileName, ...flags, '-###']) !== 0) throw new Error(state.err.trim().slice(0, 400) || '编译器的驱动失败了');
    const lines = state.err.split('\n');
    const pick = key => {
      const line = lines.find(item => item.includes(key)) || '';
      const args = (line.match(/"([^"]*)"/g) || []).map(item => item.slice(1, -1)).slice(1);
      const at = args.indexOf('-o');
      return { args, output: at < 0 ? '' : args[at + 1] };
    };
    const cc1 = pick('-cc1'), linker = pick('wasm-ld');
    if (!cc1.args.length || !linker.args.length) throw new Error(state.err.trim().slice(0, 400) || '编译器没有给出编译命令');
    return { cc1, linker };
  };
  return async function compile({ source, fileName = 'main.c', flags = [] }) {
    let stderr = '';
    const note = data => { stderr += data + '\n'; };
    const invocation = await invocationFor(fileName, source, flags);
    const clang = await Clang({ thisProgram: 'clang', printErr: note });
    clang.FS.writeFile(fileName, source);
    setUpSysroot(clang, sysroot);
    if (clang.callMain(invocation.cc1.args) !== 0) return { module: null, compileOutput: stderr };
    const object = clang.FS.readFile(invocation.cc1.output, { encoding: 'binary' });
    const linker = await LLD({ thisProgram: 'wasm-ld', printErr: note });
    linker.FS.writeFile(invocation.cc1.output, object);
    setUpSysroot(linker, sysroot);
    if (linker.callMain(invocation.linker.args) !== 0) return { module: null, compileOutput: stderr };
    const binary = linker.FS.readFile(invocation.linker.output, { encoding: 'binary' });
    return { module: await WebAssembly.compile(binary), compileOutput: stderr };
  };
}
