//-------------------------------------------------------------------------------------------------------
// Copyright (C) Microsoft. All rights reserved.
// Licensed under the MIT license. See LICENSE.txt file in the project root for full license information.
//-------------------------------------------------------------------------------------------------------

import * as FS from "fs";
import * as Path from "path";
import { execSync } from "child_process";

const VERSION = require('../../../package.json').version;

import { Command } from "commander";
const program = new Command();
program.version(VERSION);

import { MIRAssembly, PackageConfig, MIRInvokeBodyDecl, MIRType } from "../../compiler/mir_assembly";
import { MIREmitter } from "../../compiler/mir_emitter";
import { CPPEmitter } from "../../tooling/aot/cppdecls_emitter";
import chalk from "chalk";

const scratchroot = Path.normalize(Path.join(__dirname, "../../scratch/"));
const binroot = Path.normalize(Path.join(__dirname, "../../"));
const tapedeckroot = Path.normalize(Path.join(__dirname, "../../../../../../bsq/"));
const ext = process.platform == "win32" ? "exe" : "";

function generateMASM(files: string[], blevel: "debug" | "test" | "release", corelibpath: string): MIRAssembly {
    let bosque_dir: string = Path.normalize(Path.join(__dirname, "../../"));
    let code: { relativePath: string, contents: string }[] = [];
    try {
        const coredir = Path.join(bosque_dir, "core/", corelibpath);
        const corefiles = FS.readdirSync(coredir);

        for (let i = 0; i < corefiles.length; ++i) {
            const cfpath = Path.join(coredir, corefiles[i]);
            code.push({ relativePath: cfpath, contents: FS.readFileSync(cfpath).toString() });
        }
 
        for (let i = 0; i < files.length; ++i) {
            const file = { relativePath: files[i], contents: FS.readFileSync(files[i]).toString() };
            code.push(file);
        }
    }
    catch (ex) {
        process.stdout.write(`Read failed with exception -- ${ex}\n`);
        process.exit(1);
    }

    const { masm, errors } = MIREmitter.generateMASM(new PackageConfig(), blevel, true, false, code);
    if (errors.length !== 0) {
        for (let i = 0; i < errors.length; ++i) {
            process.stdout.write(chalk.red(`Parse error -- ${errors[i]}\n`));
        }

        process.exit(1);
    }

    return masm as MIRAssembly;
}

program
    .option("-e --entrypoint [entrypoint]", "Entrypoint of the exe", "NSMain::main")
    .option("-o --outfile [outfile]", "Optional name of the output exe", (process.platform === "win32") ? "a.exe" : "a.out")
    .option("-c --compiler [compiler]", "Compiler to use", (process.platform === "win32") ? "clang.exe" : "doas cling -noruntime")
    .option("-l --level [level]", "Build level version", "debug")
    .option("-f --flags <flags>", "Custom compiler flags", "")

    program.parse(process.argv);

if (process.platform == "win32" && !program.outfile.endsWith(`.${ext}`)){
    program.outfile += `.${ext}`;
}

if (program.args.length === 0) {
    process.stdout.write(chalk.red("Error -- Please specify at least one source file as an argument\n"));
    process.exit(1);
}

if(!["debug", "test", "release"].includes(program.level)) {
    process.stdout.write(chalk.red("Error -- Valid build levels are 'debug', 'test', and 'release'\n"));
    process.exit(1);
}

process.stdout.write(`Compiling Bosque sources in files:\n${program.args.join("\n")}\n...\n`);
const massembly = generateMASM(program.args, program.level, "cpp");

setImmediate((): void => {
    process.stdout.write(`Transpiling Bosque assembly to C++ with entrypoint of ${program.entrypoint}...\n`);
    const cpp_runtime = Path.join(binroot, "tooling/aot/runtime/");

    try {
        
        const cparams = CPPEmitter.emit(massembly, program.entrypoint);
        const lsrc = FS.readdirSync(cpp_runtime).filter((name) => name.endsWith(".h") || name.endsWith(".cpp"));
        const linked = lsrc.map((fname) => {
            const contents = FS.readFileSync(Path.join(cpp_runtime, fname)).toString();
            let bcontents = contents
            .replace("//%%STATIC_STRING_DECLARE%%", cparams.STATIC_STRING_DECLARE)
            .replace("//%%STATIC_STRING_CREATE%%", cparams.STATIC_STRING_CREATE)
            .replace("//%%STATIC_REGEX_DECLARE%%", cparams.STATIC_REGEX_DECLARE)
            .replace("//%%STATIC_REGEX_CREATE%%", cparams.STATIC_REGEX_CREATE)
            .replace("//%%STATIC_INT_DECLARE%%", cparams.STATIC_INT_DECLARE)
            .replace("//%%STATIC_INT_CREATE%%", cparams.STATIC_INT_CREATE)
            .replace("//%%PROPERTY_ENUM_DECLARE%%", cparams.PROPERTY_ENUM_DECLARE) 
            .replace("//%%NOMINAL_TYPE_ENUM_DECLARE%%", cparams.NOMINAL_TYPE_ENUM_DECLARE)
            .replace("//%%PROPERTY_NAMES%%", cparams.PROPERTY_NAMES)
            .replace("//%%NOMINAL_TYPE_DISPLAY_NAMES%%", cparams.NOMINAL_TYPE_DISPLAY_NAMES)
            .replace("//%%CONCEPT_SUBTYPE_RELATION_DECLARE%%", cparams.CONCEPT_SUBTYPE_RELATION_DECLARE)
            .replace("//%%NOMINAL_TYPE_TO_DATA_KIND%%", cparams.NOMINAL_TYPE_TO_DATA_KIND);


            const bstart = bcontents.indexOf("//%%SPECIAL_NAME_BLOCK_BEGIN%%");
            const bend = bcontents.indexOf("//%%SPECIAL_NAME_BLOCK_END%%");
            if(bstart !== -1) {
                bcontents = bcontents.slice(0, bstart) + "//%%SPECIAL_NAME_BLOCK_BEGIN%%\n" + cparams.SPECIAL_NAME_BLOCK_BEGIN + "\n" + bcontents.slice(bend);
            }

            return { file: fname, contents: bcontents };
        });

        if (massembly.invokeDecls.get(program.entrypoint) === undefined) {
            process.stderr.write("Could not find specified entrypoint!!!\n");
            process.exit(1);
        }

        const entrypoint = massembly.invokeDecls.get(program.entrypoint) as MIRInvokeBodyDecl;
        if (entrypoint.params.some((p) => !massembly.subtypeOf(massembly.typeMap.get(p.type) as MIRType, massembly.typeMap.get("NSCore::APIValue") as MIRType))) {
            process.stderr.write("Only APIValue types are supported as inputs of Bosque programs.\n");
            process.exit(1);
        }

        const mainheader = "namespace BSQ\n"
        + "{\n"
        + "#pragma clang diagnostic push\n"
        + `#pragma clang diagnostic ignored \"-Wunused-parameter\"\n`
        + `#pragma clang diagnostic ignored \"-Wpessimizing-move\"\n`
        + cparams.STATIC_STRING_CREATE
        + "\n"
        + "std::string diagnostic_format(Value v)\n"
        + "{\n"
        + "    if(BSQ_IS_VALUE_NONE(v))\n"
        + "    {\n"
        + "        return std::string(\"none\");\n"
        + "    }\n"
        + "    else if(BSQ_IS_VALUE_BOOL(v))\n"
        + "    {\n"
        + "        return BSQ_GET_VALUE_BOOL(v) ? std::string(\"true\") : std::string(\"false\");\n"
        + "    }\n"
        + "    else if(BSQ_IS_VALUE_TAGGED_INT(v))\n"
        + "    {\n"
        + "        return std::to_string(BSQ_GET_VALUE_TAGGED_INT(v));\n"
        + "    }\n"
        + "    else\n"
        + "    {\n"
        + "        BSQRef* vv = BSQ_GET_VALUE_PTR(v, BSQRef);\n"
        + "\n"        
        + "        auto rcategory = GET_MIR_TYPE_CATEGORY(vv->nominalType);\n"
        + "        switch(rcategory)\n"
        + "        {\n"
        + "            case MIRNominalTypeEnum_Category_BigInt:\n"
        + "               return DisplayFunctor_BSQBigInt{}(dynamic_cast<BSQBigInt*>(vv));\n"
        + "            case MIRNominalTypeEnum_Category_String:\n"
        + "               return DisplayFunctor_BSQString{}(dynamic_cast<BSQString*>(vv));\n"
        + "            case MIRNominalTypeEnum_Category_SafeString:\n"
        + "               return DisplayFunctor_BSQSafeString{}(dynamic_cast<BSQSafeString*>(vv));\n"
        + "            case MIRNominalTypeEnum_Category_StringOf:\n"
        + "               return DisplayFunctor_BSQStringOf{}(dynamic_cast<BSQStringOf*>(vv));\n"
        + "            case MIRNominalTypeEnum_Category_UUID:\n"
        + "               return DisplayFunctor_BSQUUID{}(dynamic_cast<Boxed_BSQUUID*>(vv)->bval);\n"
        + "            case MIRNominalTypeEnum_Category_LogicalTime:\n"
        + "               return DisplayFunctor_BSQLogicalTime{}(dynamic_cast<Boxed_BSQLogicalTime*>(vv)->bval);\n"
        + "            case MIRNominalTypeEnum_Category_CryptoHash:\n"
        + "               return DisplayFunctor_BSQCryptoHash{}(dynamic_cast<BSQCryptoHash*>(vv));\n"
        + "            case MIRNominalTypeEnum_Category_Enum:\n"
        + "               return DisplayFunctor_BSQEnum{}(dynamic_cast<Boxed_BSQEnum*>(vv)->bval);\n"
        + "            case MIRNominalTypeEnum_Category_IdKeySimple:\n"
        + "               return DisplayFunctor_BSQIdKeySimple{}(dynamic_cast<Boxed_BSQIdKeySimple*>(vv)->bval);\n"
        + "            case MIRNominalTypeEnum_Category_IdKeyCompound:\n"
        + "               return DisplayFunctor_BSQIdKeyCompound{}(dynamic_cast<Boxed_BSQIdKeyCompound*>(vv)->bval);\n"
        + "            case MIRNominalTypeEnum_Category_Float64:\n"
        + "               return DisplayFunctor_double{}(dynamic_cast<Boxed_double*>(vv)->bval);\n"
        + "            case MIRNominalTypeEnum_Category_ByteBuffer:\n"
        + "               return DisplayFunctor_BSQByteBuffer{}(dynamic_cast<BSQByteBuffer*>(vv));\n"
        + "            case MIRNominalTypeEnum_Category_Buffer:\n"
        + "               return DisplayFunctor_BSQBuffer{}(dynamic_cast<BSQBuffer*>(vv));\n"
        + "            case MIRNominalTypeEnum_Category_BufferOf:\n"
        + "               return DisplayFunctor_BSQBufferOf{}(dynamic_cast<BSQBufferOf*>(vv));\n"
        + "            case MIRNominalTypeEnum_Category_ISOTime:\n"
        + "               return DisplayFunctor_BSQISOTime{}(dynamic_cast<Boxed_BSQISOTime*>(vv)->bval);\n"
        + "            case MIRNominalTypeEnum_Category_Regex:\n"
        + "               return DisplayFunctor_BSQRegex{}(dynamic_cast<Boxed_BSQRegex*>(vv)->bval);\n"
        + "            case MIRNominalTypeEnum_Category_Tuple:\n"
        + "               return DisplayFunctor_BSQTuple{}(*dynamic_cast<BSQTuple*>(vv));\n"
        + "            case MIRNominalTypeEnum_Category_Record:\n"
        + "               return DisplayFunctor_BSQRecord{}(*dynamic_cast<BSQRecord*>(vv));\n"
        + "            default:\n"
        + "               return dynamic_cast<BSQObject*>(vv)->display();\n"
        + "         }\n"
        + "     }\n"
        + "}\n"
        + "/*forward type decls*/\n"
        + cparams.TYPEDECLS_FWD
        + "\n\n/*type decls*/\n"
        + cparams.TYPEDECLS
        + "\n\n/*ephemeral decls*/\n"
        + cparams.EPHEMERAL_LIST_DECLARE
        + "\n\n/*forward vable decls*/\n"
        + "\n\n/*forward function decls*/\n"
        + cparams.FUNC_DECLS_FWD
        + "\n\n/*typecheck decls*/\n"
        + cparams.TYPECHECKS
        + "\n\n/*vable decls*/\n"
        + cparams.VFIELD_ACCESS
        + "\n\n/*function decls*/\n"
        + cparams.FUNC_DECLS
        + "#pragma clang diagnostic pop\n"
        + "}\n\n"

        process.stdout.write(`Searching files for runtime:\n`)
        
        const runtime = linked.map((fname) => 
        {
            
            process.stdout.write(fname.file+`\n`);

            if(fname.file == "bsqruntime.h")
            {
                process.stdout.write(`Found Runtime\n`);
                //process.stdout.write(fname.contents+`\n`);
                return fname.contents;
            }
            
            return "";
        });

        linked.push({ file: "bsqruntime.h", contents: runtime.join('') + "\n" + mainheader });

        const maincpp = "#include \"bsqruntime.h\"\n"
            + "using namespace BSQ;"
            + "\n\n/*main decl*/\n"
            + cparams.MAIN_CALL
        linked.push({ file: "bsq.cpp", contents: maincpp });

        process.stdout.write(`Writing C++ files...\n`);
        const cpppath = Path.join(scratchroot, "cpp");
        FS.mkdirSync(cpppath, { recursive: true });

        linked.forEach((fp) => {
            const outfile = Path.join(cpppath, fp.file);
            FS.writeFileSync(outfile, fp.contents);
        });

        const customsrc = Path.join(cpp_runtime, "bsqcustom")
        const custompath = Path.join(cpppath, "bsqcustom");
        FS.mkdirSync(custompath, { recursive: true });
        const csrc = FS.readdirSync(customsrc).filter((name) => name.endsWith(".h"));

        csrc.forEach((cf) => {
            const fromfile = Path.join(customsrc, cf);
            const outfile = Path.join(custompath, cf);

            const contents = FS.readFileSync(fromfile).toString();
            FS.writeFileSync(outfile, contents);
        });

        /*
        let buildOpts = "";
        if(program.level === "debug") {
            buildOpts = " -g -DBDEBUG";
        }
        else if (program.level === "test") {
            buildOpts = " -g -DBDEBUG -Os"
        }
        else {
            buildOpts = " -Os -march=native"
        }

        if(program.flags) {
            buildOpts += ` ${program.flags}`;
        }*/

        const buildstring = `${program.compiler} -std=c++17`;
        process.stdout.write(`Executing C++ code with ${buildstring} ${cpppath}/bsq.cpp\n`);
        
        execSync(`${program.compiler} -std=c++17 ${cpppath}/bsq.cpp`,{stdio: 'inherit'});

        const mainrs = "#![recursion_limit = \"4096\"]\n"
        + "\n"
        + "use cpp::*;\n"
        + "\n"
        + "cpp! {{\n"
        + "#include <iostream>\n"
        + "#include \"bsqruntime.h\"\n"
        + "}}\n"
        + "pub fn bsq() {\n"
        + "let name = std::ffi::CString::new(\"BSQ Finished Executing\").unwrap();\n"
        + "let name_ptr = name.as_ptr();\n"
        + "let r = unsafe {\n"
        + "cpp!([name_ptr as \"const char *\"] -> u32 as \"int32_t\" {\n"
        + "\n"
        + "    using namespace BSQ;"
        + "\n\n/*main decl*/\n"
        + "    " + cparams.MAIN_CALLRS
        + "    })\n"
        + "};\n"
        + "assert_eq!(r, 0);\n"
        + "}\n"
        linked.push({ file: "lib.rs", contents: mainrs });

        process.stdout.write(`Writing TapeDeck files...\n`);
        const rspath = Path.join(tapedeckroot, "src");
        FS.mkdirSync(rspath, { recursive: true });

        linked.forEach((fp) => {
            const outfile = Path.join(rspath, fp.file);
            if(fp.file !== "bsq.cpp")
            {
                FS.writeFileSync(outfile, fp.contents);
            }
        });

        const customsrcrs = Path.join(cpp_runtime, "bsqcustom")
        const custompathrs = Path.join(rspath, "bsqcustom");
        FS.mkdirSync(custompathrs, { recursive: true });
        const srcrs = FS.readdirSync(customsrcrs).filter((name) => name.endsWith(".h"));

        srcrs.forEach((cf) => {
            const fromfile = Path.join(customsrcrs, cf);
            const outfile = Path.join(custompathrs, cf);

            const contents = FS.readFileSync(fromfile).toString();
            FS.writeFileSync(outfile, contents);
        });

        execSync("cargo run -p tapedeck",{stdio: 'inherit'});


    }   
    catch (ex) {
        process.stderr.write(chalk.red(`Error -- ${ex}\n`));
    }
    process.stdout.write(chalk.green(`Finished executing BSQ\n`));
});
