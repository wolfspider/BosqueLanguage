//-------------------------------------------------------------------------------------------------------
// Copyright (C) Microsoft. All rights reserved.
// Licensed under the MIT license. See LICENSE.txt file in the project root for full license information.
//-------------------------------------------------------------------------------------------------------

import { MIRAssembly, MIRType, MIRInvokeDecl, MIRInvokeBodyDecl, MIRInvokePrimitiveDecl, MIRConstantDecl, MIRFieldDecl, MIREntityTypeDecl, MIRFunctionParameter, MIREntityType, MIRTupleType, MIRRecordType, MIRConceptType, MIREphemeralListType, MIRPCode, MIRRegex } from "../../compiler/mir_assembly";
import { CPPTypeEmitter } from "./cpptype_emitter";
import { MIRArgument, MIRRegisterArgument, MIRConstantNone, MIRConstantFalse, MIRConstantTrue, MIRConstantInt, MIRConstantArgument, MIRConstantString, MIROp, MIROpTag, MIRLoadConst, MIRAccessArgVariable, MIRAccessLocalVariable, MIRInvokeFixedFunction, MIRPrefixOp, MIRBinOp, MIRBinEq, MIRBinCmp, MIRIsTypeOfNone, MIRIsTypeOfSome, MIRRegAssign, MIRTruthyConvert, MIRVarStore, MIRReturnAssign, MIRDebug, MIRJump, MIRJumpCond, MIRJumpNone, MIRAbort, MIRBasicBlock, MIRPhi, MIRConstructorTuple, MIRConstructorRecord, MIRAccessFromIndex, MIRAccessFromProperty, MIRInvokeKey, MIRAccessConstantValue, MIRLoadFieldDefaultValue, MIRBody, MIRConstructorPrimary, MIRAccessFromField, MIRConstructorPrimaryCollectionEmpty, MIRConstructorPrimaryCollectionSingletons, MIRIsTypeOf, MIRProjectFromIndecies, MIRModifyWithIndecies, MIRStructuredExtendTuple, MIRProjectFromProperties, MIRModifyWithProperties, MIRStructuredExtendRecord, MIRLoadConstTypedString, MIRConstructorEphemeralValueList, MIRProjectFromFields, MIRModifyWithFields, MIRStructuredExtendObject, MIRLoadConstSafeString, MIRInvokeInvariantCheckDirect, MIRLoadFromEpehmeralList, MIRConstantBigInt, MIRConstantFloat64, MIRFieldKey, MIRResolvedTypeKey, MIRPackSlice, MIRPackExtend, MIRNominalTypeKey, MIRBinLess, MIRConstantRegex } from "../../compiler/mir_ops";
import { topologicalOrder } from "../../compiler/mir_info";

import * as assert from "assert";
import { StructRepr, RefRepr, ValueRepr, KeyValueRepr, NoneRepr } from "./type_repr";
import { compileRegexCppMatch } from "./cpp_regex";

function NOT_IMPLEMENTED<T>(msg: string): T {
    throw new Error(`Not Implemented: ${msg}`);
}

function filenameClean(file: string): string {
    return file.replace(/[\\]/g, "/");
}

class CPPBodyEmitter {
    readonly assembly: MIRAssembly;
    readonly typegen: CPPTypeEmitter;

    readonly allPropertyNames: Set<string> = new Set<string>();
    readonly allConstStrings: Map<string, string> = new Map<string, string>();
    readonly allConstRegexes: Map<string, string> = new Map<string, string>();
    readonly allConstBigInts: Map<string, string> = new Map<string, string>();

    private currentFile: string = "[No File]";
    private currentRType: MIRType;

    private vtypes: Map<string, MIRType> = new Map<string, MIRType>();
    private generatedBlocks: Map<string, string[]> = new Map<string, string[]>();

    private subtypeOrderCtr = 0;
    subtypeFMap: Map<string, {order: number, decl: string}> = new Map<string, {order: number, decl: string}>();
    checkedConcepts: Set<MIRResolvedTypeKey> = new Set<MIRResolvedTypeKey>();

    vfieldLookups: { infertype: MIRType, fdecl: MIRFieldDecl, lname: string }[] = [];
    vfieldProjects: { infertype: MIRType, fprojs: MIRFieldDecl[], resultAccessType: MIRType, uname: string }[] = [];
    vfieldUpdates: { infertype: MIRType, fupds: [MIRFieldDecl, MIRArgument][], resultAccessType: MIRType, uname: string }[] = [];
    vobjmerges: { infertype: MIRType, merge: MIRArgument, infermergetype: MIRType, fieldResolves: [string, MIRFieldDecl][], resultAccessType: MIRType, mname: string }[] = [];

    constructor(assembly: MIRAssembly, typegen: CPPTypeEmitter) {
        this.assembly = assembly;
        this.typegen = typegen;

        this.currentRType = typegen.noneType;
    }

    private static cleanStrRepr(s: string): string {
        return "\"" + s.substring(1, s.length - 1) + "\"";
    }

    labelToCpp(label: string): string {
        return label;
    }

    varNameToCppName(name: string): string {
        if (name === "this") {
            return this.typegen.mangleStringForCpp("$this");
        }
        else if (name === "$$return") {
            return "$$return";
        }
        else {
            return this.typegen.mangleStringForCpp(name);
        }
    }

    varToCppName(varg: MIRRegisterArgument): string {
        return this.varNameToCppName(varg.nameID);
    }

    invokenameToCPP(ivk: MIRInvokeKey): string {
        return this.typegen.mangleStringForCpp(ivk);
    }

    getArgType(arg: MIRArgument): MIRType {
        if (arg instanceof MIRRegisterArgument) {
            return this.vtypes.get(arg.nameID) as MIRType;
        }
        else {
            if (arg instanceof MIRConstantNone) {
                return this.typegen.noneType;
            }
            else if (arg instanceof MIRConstantTrue || arg instanceof MIRConstantFalse) {
                return this.typegen.boolType;
            }
            else if (arg instanceof MIRConstantInt) {
                return this.typegen.intType;
            }
            else if (arg instanceof MIRConstantString) {
                return this.typegen.stringType;
            }
            else {
                return this.typegen.regexType;
            }
        }
    }

    generateConstantExp(cval: MIRConstantArgument, into: MIRType): string {
        if (cval instanceof MIRConstantNone) {
            return this.typegen.coerce("BSQ_VALUE_NONE", this.typegen.noneType, into);
        }
        else if (cval instanceof MIRConstantTrue) {
            return this.typegen.coerce("BSQTRUE", this.typegen.boolType, into);
        }
        else if (cval instanceof MIRConstantFalse) {
            return this.typegen.coerce("BSQFALSE", this.typegen.boolType, into);
        }
        else if (cval instanceof MIRConstantInt) {
            return this.typegen.coerce(cval.value, this.typegen.intType, into);
        }
        else if (cval instanceof MIRConstantBigInt) {
            const sname = "BIGINT__" + this.allConstBigInts.size;
            if (!this.allConstBigInts.has(cval.value)) {
                this.allConstBigInts.set(cval.value, sname);
            }

            const bint = `(Runtime::${this.allConstBigInts.get(cval.value) as string})`;
            return this.typegen.coerce(bint, this.typegen.bigIntType, into);
        }
        else if (cval instanceof MIRConstantFloat64) {
            return this.typegen.coerce(cval.digits(), this.typegen.float64Type, into);
        }
        else if (cval instanceof MIRConstantString) {
            assert(cval instanceof MIRConstantString);

            const sval = CPPBodyEmitter.cleanStrRepr((cval as MIRConstantString).value);
            const sname = "STR__" + this.allConstStrings.size;
            if (!this.allConstStrings.has(sval)) {
                this.allConstStrings.set(sval, sname);
            }

            const strval = `(&Runtime::${this.allConstStrings.get(sval) as string})`;
            return this.typegen.coerce(strval, this.typegen.stringType, into);
        }
        else {
            assert(cval instanceof MIRConstantRegex);

            const rval = (cval as MIRConstantRegex).value;
            const rname = "REGEX__" + this.allConstRegexes.size;
            if (!this.allConstRegexes.has(rval)) {
                this.allConstRegexes.set(rval, rname);
            }

            const strval = `(&Runtime::${this.allConstRegexes.get(rval) as string})`;
            return this.typegen.coerce(strval, this.typegen.regexType, into);
        }
    }

    argToCpp(arg: MIRArgument, into: MIRType): string {
        if (arg instanceof MIRRegisterArgument) {
            return this.typegen.coerce(this.varToCppName(arg), this.getArgType(arg), into);
        }
        else {
            return this.generateConstantExp(arg as MIRConstantArgument, into);
        }
    }

    generateTruthyConvert(arg: MIRArgument): string {
        const argtype = this.getArgType(arg);

        if (this.assembly.subtypeOf(argtype, this.typegen.noneType)) {
            return "false";
        }
        else if (this.assembly.subtypeOf(argtype, this.typegen.boolType)) {
            return this.argToCpp(arg, this.typegen.boolType);
        }
        else {
            return `BSQ_GET_VALUE_TRUTHY(${this.varToCppName(arg)})`;
        }
    }

    generateNoneCheck(arg: MIRArgument): string {
        const argtype = this.getArgType(arg);

        if (this.assembly.subtypeOf(argtype, this.typegen.noneType)) {
            return "true";
        }
        else if (!this.assembly.subtypeOf(this.typegen.noneType, argtype)) {
            return "false";
        }
        else {
            return `BSQ_IS_VALUE_NONE(${this.varToCppName(arg)})`;
        }
    }

    generateLoadConstSafeString(op: MIRLoadConstSafeString): string {
        const sval = CPPBodyEmitter.cleanStrRepr(op.ivalue);
        const sname = "STR__" + this.allConstStrings.size;

        if (!this.allConstStrings.has(sval)) {
            this.allConstStrings.set(sval, sname);
        }
        const strval = `Runtime::${this.allConstStrings.get(sval) as string}`;

        const scopevar = this.varNameToCppName("$scope$");
        return `${this.varToCppName(op.trgt)} =  BSQ_NEW_ADD_SCOPE(${scopevar}, BSQSafeString, ${strval}.sdata, MIRNominalTypeEnum::${this.typegen.mangleStringForCpp(op.tskey)});`;
    }

    generateLoadConstTypedString(op: MIRLoadConstTypedString): string {
        const sval = CPPBodyEmitter.cleanStrRepr(op.ivalue);
        const sname = "STR__" + this.allConstStrings.size;

        if (!this.allConstStrings.has(sval)) {
            this.allConstStrings.set(sval, sname);
        }
        const strval = `Runtime::${this.allConstStrings.get(sval) as string}`;

        const scopevar = this.varNameToCppName("$scope$");

        let opstrs: string[] = [];
        if(op.pfunckey !== undefined) {
            const pfunc = (this.typegen.assembly.invokeDecls.get(op.pfunckey) || this.typegen.assembly.primitiveInvokeDecls.get(op.pfunckey)) as MIRInvokeDecl;
            const errtype = this.typegen.getMIRType(op.errtype as MIRResolvedTypeKey);

            const pexp = `${this.invokenameToCPP(op.pfunckey)}(&${strval}, ${scopevar})`;
            const tcexp = this.generateTypeCheck(pexp, this.typegen.getMIRType(pfunc.resultType), this.typegen.getMIRType(pfunc.resultType), errtype);
            opstrs.push(`if(${tcexp}) { BSQ_ABORT("Failed string validation", "${filenameClean(this.currentFile)}", ${op.sinfo.line}); }`);
        }

        opstrs.push(`${this.varToCppName(op.trgt)} =  BSQ_NEW_ADD_SCOPE(${scopevar}, BSQStringOf, ${strval}.sdata, MIRNominalTypeEnum::${this.typegen.mangleStringForCpp(op.tskey)});`);

        return opstrs.join(" ");
    }

    generateAccessConstantValue(cp: MIRAccessConstantValue): string {
        const cdecl = this.assembly.constantDecls.get(cp.ckey) as MIRConstantDecl;
        const scopevar = this.typegen.getRefCountableStatus(this.typegen.getMIRType(cdecl.declaredType)) !== "no" ? this.varNameToCppName("$scope$") : "";
        return `${this.varToCppName(cp.trgt)} = ${this.invokenameToCPP(cdecl.value)}(${scopevar});`;
    }

    generateLoadFieldDefaultValue(ld: MIRLoadFieldDefaultValue): string {
        const fdecl = this.assembly.fieldDecls.get(ld.fkey) as MIRFieldDecl;
        const scopevar = this.typegen.getRefCountableStatus(this.typegen.getMIRType(fdecl.declaredType)) !== "no" ? this.varNameToCppName("$scope$") : "";
        return `${this.varToCppName(ld.trgt)} = ${this.invokenameToCPP(fdecl.value as MIRInvokeKey)}(${scopevar});`;
    }

    generateMIRInvokeInvariantCheckDirect(ivop: MIRInvokeInvariantCheckDirect): string {
        const fields = [...(this.typegen.assembly.entityDecls.get(ivop.tkey) as MIREntityTypeDecl).fields];
        const args = fields.map((f) => `${this.argToCpp(ivop.rcvr, this.typegen.getMIRType(ivop.tkey))}->${this.typegen.mangleStringForCpp(f.fkey)}`);

        return `${this.varToCppName(ivop.trgt)} = ${this.invokenameToCPP(ivop.ikey)}(${args.join(", ")});`;
    }

    generateMIRConstructorPrimary(cp: MIRConstructorPrimary): string {
        const ctype = this.assembly.entityDecls.get(cp.tkey) as MIREntityTypeDecl;

        const cppcrepr = this.typegen.getCPPReprFor(this.typegen.getMIRType(cp.tkey));
        if (cppcrepr instanceof StructRepr) {
            const fvals = cp.args.map((arg, i) => {
                const ftype = this.typegen.getMIRType(ctype.fields[i].declaredType);
                return this.argToCpp(arg, ftype);
            });

            return `${this.varToCppName(cp.trgt)} = std::move(${cppcrepr.base}(${fvals.join(", ")}));`
        }
        else {
            const fvals = cp.args.map((arg, i) => {
                const ftype = this.typegen.getMIRType(ctype.fields[i].declaredType);
                return this.typegen.generateConstructorArgInc(ftype, this.argToCpp(arg, ftype));
            });

            const scopevar = this.varNameToCppName("$scope$");
            return `${this.varToCppName(cp.trgt)} = BSQ_NEW_ADD_SCOPE(${scopevar}, ${cppcrepr.base}${fvals.length !== 0 ? (", " + fvals.join(", ")) : ""});`;
        }
    }

    generateMIRConstructorPrimaryCollectionEmpty(cpce: MIRConstructorPrimaryCollectionEmpty): string {
        const cpetype = this.typegen.getMIRType(cpce.tkey);
        const cppctype = this.typegen.getCPPReprFor(cpetype).base;

        const scopevar = this.varNameToCppName("$scope$");
        const conscall = `BSQ_NEW_ADD_SCOPE(${scopevar}, ${cppctype}, MIRNominalTypeEnum::${this.typegen.mangleStringForCpp(cpce.tkey)})`;

        return `${this.varToCppName(cpce.trgt)} = ${conscall};`;
    }

    generateMIRConstructorPrimaryCollectionSingletons(cpcs: MIRConstructorPrimaryCollectionSingletons): string {
        const cpcstype = this.typegen.getMIRType(cpcs.tkey);
        const cppctype = this.typegen.getCPPReprFor(cpcstype).base;

        let conscall = "";
        const scopevar = this.varNameToCppName("$scope$");
        const ntype = `MIRNominalTypeEnum::${this.typegen.mangleStringForCpp(cpcs.tkey)}`
        if (this.typegen.typecheckIsName(cpcstype, /^NSCore::List<.*>$/)) {
            const oftype = (this.assembly.entityDecls.get(cpcs.tkey) as MIREntityTypeDecl).terms.get("T") as MIRType;
            const cvals = cpcs.args.map((arg) => this.typegen.generateConstructorArgInc(oftype, this.argToCpp(arg, oftype)));

            conscall = `BSQ_NEW_ADD_SCOPE(${scopevar}, ${cppctype}, ${ntype}, { ${cvals.join(", ")} })`;
        }
        else if (this.typegen.typecheckIsName(cpcstype, /^NSCore::Stack<.*>$/)) {
            const oftype = (this.assembly.entityDecls.get(cpcs.tkey) as MIREntityTypeDecl).terms.get("T") as MIRType;
            const cvals = cpcs.args.map((arg) => this.typegen.generateConstructorArgInc(oftype, this.argToCpp(arg, oftype)));

            conscall = `BSQ_NEW_ADD_SCOPE(${scopevar}, ${cppctype}, ${ntype}, { ${cvals.join(", ")} })`;
        }
        else if (this.typegen.typecheckIsName(cpcstype, /^NSCore::Queue<.*>$/)) {
            const oftype = (this.assembly.entityDecls.get(cpcs.tkey) as MIREntityTypeDecl).terms.get("T") as MIRType;
            const cvals = cpcs.args.map((arg) => this.typegen.generateConstructorArgInc(oftype, this.argToCpp(arg, oftype)));

            conscall = `BSQ_NEW_ADD_SCOPE(${scopevar}, ${cppctype}, ${ntype}, { ${cvals.join(", ")} })`;
        }
        else if (this.typegen.typecheckIsName(cpcstype, /^NSCore::Set<.*>$/) || this.typegen.typecheckIsName(cpcstype, /^NSCore::DynamicSet<.*>$/)) {
            const oftype = (this.assembly.entityDecls.get(cpcs.tkey) as MIREntityTypeDecl).terms.get("T") as MIRType;
            const cvals = cpcs.args.map((arg) => this.argToCpp(arg, oftype));

            const trepr = this.typegen.getCPPReprFor(oftype);
            const tops = this.typegen.getFunctorsForType(oftype);

            const pvals = `BSQSet<${trepr.std}, ${tops.dec}, ${tops.display}, ${tops.less}, ${tops.eq}>::processSingletonSetInit<${tops.inc}>({ ${cvals} })`
            conscall = `BSQ_NEW_ADD_SCOPE(${scopevar}, ${cppctype}, ${ntype}, ${pvals})`;
        }
        else {
            const ktype = (this.assembly.entityDecls.get(cpcs.tkey) as MIREntityTypeDecl).terms.get("K") as MIRType;
            const vtype = (this.assembly.entityDecls.get(cpcs.tkey) as MIREntityTypeDecl).terms.get("V") as MIRType;

            const entrytype = [...this.typegen.assembly.entityDecls].find((edecl) => edecl[1].ns === "NSCore" && edecl[1].name === "MapEntry" && (edecl[1].terms.get("K") as MIRType).trkey === ktype.trkey && (edecl[1].terms.get("V") as MIRType).trkey === vtype.trkey);
            const entryentity = (entrytype as [string, MIREntityTypeDecl])[1];
            const oftype = this.typegen.getMIRType(entryentity.tkey);

            const entrykaccess = this.typegen.mangleStringForCpp((entryentity.fields.find((fd) => fd.name === "key") as MIRFieldDecl).fkey);
            const entryvaccess = this.typegen.mangleStringForCpp((entryentity.fields.find((fd) => fd.name === "value") as MIRFieldDecl).fkey);

            const cvals = cpcs.args.map((arg) => `MEntry<${this.typegen.getCPPReprFor(ktype).std}, ${this.typegen.getCPPReprFor(vtype).std}>{${this.argToCpp(arg, oftype)}.${entrykaccess}, ${this.argToCpp(arg, oftype)}.${entryvaccess}}`);

            const krepr = this.typegen.getCPPReprFor(ktype);
            const kops = this.typegen.getFunctorsForType(ktype);
            const vrepr = this.typegen.getCPPReprFor(vtype);
            const vops = this.typegen.getFunctorsForType(vtype);

            const pvals = `BSQMap<${krepr.std}, ${kops.dec}, ${kops.display}, ${kops.less}, ${kops.eq}, ${vrepr.std}, ${vops.dec}, ${vops.display}>::processSingletonMapInit<${kops.inc}, ${vops.inc}>({ ${cvals} })`
            conscall = `BSQ_NEW_ADD_SCOPE(${scopevar}, ${cppctype}, ${ntype}, ${pvals})`;
        }

        return `${this.varToCppName(cpcs.trgt)} = ${conscall};`;
    }

    generateMIRConstructorTuple(op: MIRConstructorTuple): string {
        const args = op.args.map((arg) => this.argToCpp(arg, this.typegen.anyType));

        if(args.length === 0) {
            return `${this.varToCppName(op.trgt)} = BSQTuple::_empty;`;
        }
        else {
            const iflag = this.typegen.generateInitialDataKindFlag(this.typegen.getMIRType(op.resultTupleType));
            return `${this.varToCppName(op.trgt)} = BSQTuple::createFromSingle<${iflag}>({ ${args.join(", ")} });`;
        }
    }

    generateMIRConstructorRecord(op: MIRConstructorRecord): string {
        const args = op.args.map((arg) => `std::make_pair(MIRPropertyEnum::${arg[0]}, ${this.argToCpp(arg[1], this.typegen.anyType)})`);

        if(args.length === 0) {
            return `${this.varToCppName(op.trgt)} = BSQRecord::_empty;`;
        }
        else {
            const iflag = this.typegen.generateInitialDataKindFlag(this.typegen.getMIRType(op.resultRecordType));
            return `${this.varToCppName(op.trgt)} = BSQRecord::createFromSingle<${iflag}>({ ${args.join(", ")} });`;
        }
    }

    generateMIRConstructorEphemeralValueList(op: MIRConstructorEphemeralValueList): string {
        const etype = this.typegen.getMIRType(op.resultEphemeralListType).options[0] as MIREphemeralListType;

        let args: string[] = [];
        for(let i = 0; i < op.args.length; ++i) {
            args.push(this.argToCpp(op.args[i], etype.entries[i]));
        }

        return `${this.varToCppName(op.trgt)} = ${this.typegen.mangleStringForCpp(etype.trkey)}{${args.join(", ")}};`;
    }

    generateMIRAccessFromIndexExpression(arg: MIRArgument, idx: number, resultAccessType: MIRType): string {
        const tuptype = this.getArgType(arg);
        const hasidx = this.typegen.tupleHasIndex(tuptype, idx);

        if(hasidx === "no") {
            return `${this.typegen.coerce("BSQ_VALUE_NONE", this.typegen.noneType, resultAccessType)}`;
        }
        else {
            const trepr = this.typegen.getCPPReprFor(tuptype);
            let select = "";
            if(trepr instanceof StructRepr) {
                select = `${this.varToCppName(arg)}.atFixed<${idx}>()`;
            }
            else {
                select = `BSQ_GET_VALUE_PTR(${this.varToCppName(arg)}, BSQTuple)->atFixed<${idx}>()`;
            }

            return `${this.typegen.coerce(select, this.typegen.anyType, resultAccessType)}`;
        }
    }

    generateMIRProjectFromIndecies(op: MIRProjectFromIndecies, resultAccessType: MIRType): string {
        const intotypes = this.typegen.typecheckEphemeral(resultAccessType) ? (resultAccessType.options[0] as MIREphemeralListType).entries : [];
        let vals: string[] = [];

        for (let i = 0; i < op.indecies.length; ++i) {
            vals.push(this.generateMIRAccessFromIndexExpression(op.arg, op.indecies[i], intotypes[i] || this.typegen.anyType));
        }

        if (this.typegen.typecheckEphemeral(resultAccessType)) {
            return `${this.varToCppName(op.trgt)} = ${this.typegen.mangleStringForCpp(resultAccessType.trkey)}{${vals.join(", ")}};`;
        }
        else {
            const iflag = this.typegen.generateInitialDataKindFlag(resultAccessType);
            return `${this.varToCppName(op.trgt)} = BSQTuple::createFromSingle<${iflag}>({ ${vals.join(", ")} });`;
        }
    }

    generateMIRModifyWithIndecies(op: MIRModifyWithIndecies, resultTupleType: MIRType): string {
        const updmax = Math.max(...op.updates.map((upd) => upd[0] + 1));

        let cvals: string[] = [];
        for (let i = 0; i < updmax; ++i) {
            const upd = op.updates.find((update) => update[0] === i);
            if (upd !== undefined) {
                cvals.push(this.argToCpp(upd[1], this.typegen.anyType));
            }
            else {
                cvals.push(this.generateMIRAccessFromIndexExpression(op.arg, i, this.typegen.anyType));
            }
        }

        const rmax = this.typegen.getMaxTupleLength(resultTupleType);
        for (let i = updmax; i < rmax; ++i) {
            //may put none in the constructor list but ok since we note correct length and will ignore these if extranious
            cvals.push(this.generateMIRAccessFromIndexExpression(op.arg, i, this.typegen.anyType));
        }

        const iflag = this.typegen.generateInitialDataKindFlag(resultTupleType);
        return `${this.varToCppName(op.trgt)} = BSQTuple::createFromSingle<${iflag}>({ ${cvals.join(", ")} });`;
    }

    generateMIRStructuredExtendTuple(op: MIRStructuredExtendTuple, resultTupleType: MIRType): string {
         //this is the exact number of indecies in arg -- see typecheck
         const btuple = this.typegen.getMaxTupleLength(this.typegen.getMIRType(op.argInferType));

        let cvals: string[] = [];
        for (let i = 0; i < btuple; ++i) {
            cvals.push(this.generateMIRAccessFromIndexExpression(op.arg, i, this.typegen.anyType));
        }

        const rmax = this.typegen.getMaxTupleLength(resultTupleType);
        for (let i = btuple; i < rmax; ++i) {
            //may put none in the constructor list but ok since we note correct length and will ignore these if extranious
            cvals.push(this.generateMIRAccessFromIndexExpression(op.update, i - btuple, this.typegen.anyType));
        }

        const iflag = this.typegen.generateInitialDataKindFlag(resultTupleType);
        return `${this.varToCppName(op.trgt)} = BSQTuple::createFromSingle<${iflag}>({ ${cvals.join(", ")} });`;
    }

    generateMIRHasPropertyExpression(arg: MIRArgument, property: string): string {
        const rrepr = this.typegen.getCPPReprFor(this.getArgType(arg));

        if (rrepr instanceof StructRepr) {
            return `${this.varToCppName(arg)}.hasProperty<MIRPropertyEnum::${property}>()`;
        }
        else {
            return `BSQ_GET_VALUE_PTR(${this.varToCppName(arg)}, BSQRecord)->hasProperty<MIRPropertyEnum::${property}>()`;
        }
    }

    generateMIRAccessFromPropertyExpression(arg: MIRArgument, property: string, resultAccessType: MIRType): string {
        const rectype = this.getArgType(arg);
        const hasproperty = this.typegen.recordHasField(rectype, property);

        if(hasproperty === "no") {
            return `${this.typegen.coerce("BSQ_VALUE_NONE", this.typegen.noneType, resultAccessType)}`;
        }
        else {
            const rrepr = this.typegen.getCPPReprFor(rectype);
            let select = "";

            if(rrepr instanceof StructRepr) {
                select = `${this.varToCppName(arg)}.atFixed<MIRPropertyEnum::${property}>()`;
            }
            else {
                select = `BSQ_GET_VALUE_PTR(${this.varToCppName(arg)}, BSQRecord)->atFixed<MIRPropertyEnum::${property}>()`;
            }

            return `${this.typegen.coerce(select, this.typegen.anyType, resultAccessType)}`;
        }
    }

    generateMIRProjectFromProperties(op: MIRProjectFromProperties, resultAccessType: MIRType): string {
        const intotypes = this.typegen.typecheckEphemeral(resultAccessType) ? (resultAccessType.options[0] as MIREphemeralListType).entries : [];
        let vals: string[] = [];

        for (let i = 0; i < op.properties.length; ++i) {
            vals.push(this.generateMIRAccessFromPropertyExpression(op.arg, op.properties[i], intotypes[i] || this.typegen.anyType));
        }

        if (this.typegen.typecheckEphemeral(resultAccessType)) {
            return `${this.varToCppName(op.trgt)} = ${this.typegen.mangleStringForCpp(resultAccessType.trkey)}{${vals.join(", ")}};`;
        }
        else {
            const rargs: string[] = [];
            for(let i = 0; i < op.properties.length; ++i) {
                rargs.push(`{ MIRPropertyEnum::${op.properties[i]}, ${vals[i]} }`);
            }

            const iflag = this.typegen.generateInitialDataKindFlag(resultAccessType);
            return `${this.varToCppName(op.trgt)} = BSQRecord::createFromSingle<${iflag}>({ ${rargs.join(", ")} });`;
        }
    }

    generateAccessRecordPtr(argv: MIRArgument): string {
        const arg = this.varToCppName(argv);
        const rrepr = this.typegen.getCPPReprFor(this.getArgType(argv));
        if (rrepr instanceof StructRepr) {
            return `&(${arg})`;
        }
        else {
            return `BSQ_GET_VALUE_PTR(${arg}, BSQRecord)`;
        }
    }

    generateMIRModifyWithProperties(op: MIRModifyWithProperties, resultRecordType: MIRType): string {
        const pmax = this.typegen.getMaxPropertySet(resultRecordType);

        let cvals: string[] = [];
        for (let i = 0; i < pmax.length; ++i) {
            const pname = pmax[i];
            const upd = op.updates.find((update) => update[0] === pname);
            if (upd !== undefined) {
                cvals.push(`{ MIRPropertyEnum::${pname}, ${this.argToCpp(upd[1], this.typegen.anyType)} }`);
            }
        }

        const iflag = this.typegen.generateInitialDataKindFlag(resultRecordType);
        return `${this.varToCppName(op.trgt)} = BSQRecord::createFromUpdate<${iflag}>(${this.generateAccessRecordPtr(op.arg)}, { ${cvals.join(", ")} });`;
    }

    generateMIRStructuredExtendRecord(op: MIRStructuredExtendRecord, resultRecordType: MIRType): string {
        const rprops = this.typegen.getMaxPropertySet(resultRecordType);
        const mtype = this.typegen.getMIRType(op.updateInferType);

        let cvals: string[] = [];
        for(let i = 0; i < rprops.length; ++i) {
            const pname = rprops[i];
            const uhas = this.typegen.recordHasField(mtype, pname);
            if(uhas === "no") {
                //nothing to do
            }
            else if (uhas === "yes") {
                cvals.push(`{ MIRPropertyEnum::${pname}, ${this.generateMIRAccessFromPropertyExpression(op.update, pname, this.typegen.anyType)} }`);
            }
            else {
                const check = `${this.generateAccessRecordPtr(op.update)}->hasProperty(MIRPropertyEnum::${pname})`;
                cvals.push(`${check} ? ${this.generateMIRAccessFromPropertyExpression(op.update, pname, this.typegen.anyType)}) : ${this.generateMIRAccessFromPropertyExpression(op.arg, pname, this.typegen.anyType)})`);
            }
        }

        const iflag = this.typegen.generateInitialDataKindFlag(resultRecordType);
        return `${this.varToCppName(op.trgt)} = BSQRecord::createFromUpdate<${iflag}>(${this.generateAccessRecordPtr(op.arg)}, { ${cvals.join(", ")} });`;
    }

    generateVFieldLookup(arg: MIRArgument, tag: string, infertype: MIRType, fdecl: MIRFieldDecl): string {
        const lname = `resolve_${fdecl.fkey}_from_${infertype.trkey}`;
        let decl = this.vfieldLookups.find((lookup) => lookup.lname === lname);
        if(decl === undefined) {
            this.vfieldLookups.push({ infertype: infertype, fdecl: fdecl, lname: lname });
        }

        return `${this.typegen.mangleStringForCpp(lname)}(${tag}, ${this.argToCpp(arg, infertype)})`;
    }

    generateMIRAccessFromFieldExpression(arg: MIRArgument, inferargtype: MIRType, field: MIRFieldKey, resultAccessType: MIRType): string {
        const nrepr = this.typegen.getCPPReprFor(inferargtype);

        let select = "";
        if (this.typegen.typecheckUEntity(inferargtype)) {
            if (nrepr instanceof RefRepr) {
                select = `${this.argToCpp(arg, inferargtype)}->${this.typegen.mangleStringForCpp(field)}`;
            }
            else {
                select = `${this.argToCpp(arg, inferargtype)}.${this.typegen.mangleStringForCpp(field)}`;
            }
        }
        else {
            let tag = "";
            if (nrepr instanceof KeyValueRepr || nrepr instanceof ValueRepr) {
                tag = `BSQ_GET_VALUE_PTR(${this.argToCpp(arg, inferargtype)}, BSQRef)->nominalType`;
            }
            else {
                tag = `${this.argToCpp(arg, inferargtype)}.nominalType`;
            }

            select = this.generateVFieldLookup(arg, tag, inferargtype, this.assembly.fieldDecls.get(field) as MIRFieldDecl);
        }

        const ftype = this.typegen.getMIRType((this.assembly.fieldDecls.get(field) as MIRFieldDecl).declaredType);
        return `${this.typegen.coerce(select, ftype, resultAccessType)}`;
    }

    generateMIRAccessFromField(op: MIRAccessFromField, resultAccessType: MIRType): string {
        const inferargtype = this.typegen.getMIRType(op.argInferType);

        return `${this.varToCppName(op.trgt)} = ${this.generateMIRAccessFromFieldExpression(op.arg, inferargtype, op.field, resultAccessType)};`;
    }

    generateVFieldProject(arg: MIRArgument, infertype: MIRType, fprojs: MIRFieldDecl[], resultAccessType: MIRType): string {
        const upnames = fprojs.map((fp) => fp.fkey);
        const uname = `project_${upnames.sort().join("*")}_in_${infertype.trkey}`;
        let decl = this.vfieldProjects.find((lookup) => lookup.uname === uname);
        if(decl === undefined) {
            this.vfieldProjects.push({ infertype: infertype, fprojs: fprojs, resultAccessType: resultAccessType, uname: uname });
        }

        return `${this.typegen.mangleStringForCpp(uname)}(${this.argToCpp(arg, infertype)})`;
    }

    generateMIRProjectFromFields(op: MIRProjectFromFields, resultAccessType: MIRType): string {
        const inferargtype = this.typegen.getMIRType(op.argInferType);

        if (this.typegen.typecheckUEntity(inferargtype)) {
            if (this.typegen.typecheckEphemeral(resultAccessType)) {
                let cvals: string[] = [];
                op.fields.map((f, i) => {
                    const rtype = this.typegen.getEpehmeralType(resultAccessType).entries[i];
                    cvals.push(this.generateMIRAccessFromFieldExpression(op.arg, inferargtype, f, rtype));
                });

                return `${this.varToCppName(op.trgt)} = ${this.typegen.mangleStringForCpp(op.resultProjectType)}{${cvals.join(", ")}};`;
            }
            else {
                let cvals: string[] = [];
                op.fields.map((f) => {
                    const fdecl = this.assembly.fieldDecls.get(f) as MIRFieldDecl;
                    const val = this.generateMIRAccessFromFieldExpression(op.arg, inferargtype, f, this.typegen.anyType);

                    cvals.push(`{ MIRPropertyEnum::${fdecl.name}, ${val} }`);
                });

                const iflag = this.typegen.generateInitialDataKindFlag(this.typegen.getMIRType(op.resultProjectType));
                return `${this.varToCppName(op.trgt)} = BSQRecord::createFromSingle<${iflag}>({ ${cvals.join(", ")} });`;
            }
        }
        else {
            const vproject = this.generateVFieldProject(op.arg, inferargtype, op.fields.map((f) => this.assembly.fieldDecls.get(f) as MIRFieldDecl), resultAccessType);
            return `${this.varToCppName(op.trgt)} = ${vproject};`;
        }
    }

    generateVFieldUpdate(arg: MIRArgument, infertype: MIRType, fupds: [MIRFieldDecl, MIRArgument][], resultAccessType: MIRType): string {
        const upnames = fupds.map((fud) => `${fud[0].fkey}->${this.getArgType(fud[1])}`);
        const uname = `update_${upnames.sort().join("*")}_in_${infertype.trkey}`;
        let decl = this.vfieldUpdates.find((lookup) => lookup.uname === uname);
        if(decl === undefined) {
            this.vfieldUpdates.push({ infertype: infertype, fupds: fupds, resultAccessType: resultAccessType, uname: uname });
        }

        return `${this.typegen.mangleStringForCpp(uname)}(${this.argToCpp(arg, infertype)}, ${fupds.map((upd) => this.argToCpp(upd[1], this.getArgType(upd[1]))).join(", ")})`;
    }

    generateMIRModifyWithFields(op: MIRModifyWithFields, resultAccessType: MIRType): string {
        const inferargtype = this.typegen.getMIRType(op.argInferType);

        if (this.typegen.typecheckUEntity(inferargtype)) {
            const ekey = this.typegen.getEntityEKey(inferargtype);
            const utype = this.typegen.assembly.entityDecls.get(ekey) as MIREntityTypeDecl;
            let cvals: [string, MIRType][] = [];
            for (let i = 0; i < utype.fields.length; ++i) {
                const fdecl = utype.fields[i];
                const ftype = this.typegen.getMIRType(fdecl.declaredType);

                const upd = op.updates.find((update) => update[0] == fdecl.fkey);
                if(upd !== undefined) {
                    cvals.push([this.argToCpp(upd[1], ftype), ftype]);
                }
                else {
                    cvals.push([`${this.argToCpp(op.arg, inferargtype)}->${this.typegen.mangleStringForCpp(fdecl.fkey)}`, ftype]);
                }
            }

            const cppcrepr = this.typegen.getCPPReprFor(inferargtype);
            if (cppcrepr instanceof StructRepr) {
                const fvals = cvals.map((val) => {
                    return val[0];
                });

                return `${this.varToCppName(op.trgt)} = std::move(${cppcrepr.base}(${fvals.length !== 0 ? (", " + fvals.join(", ")) : ""}));`
            }
            else {
                const fvals = cvals.map((val) => {
                    return this.typegen.generateConstructorArgInc(val[1], val[0]);
                });

                const scopevar = this.varNameToCppName("$scope$");
                return `${this.varToCppName(op.trgt)} = BSQ_NEW_ADD_SCOPE(${scopevar}, ${cppcrepr.base}${fvals.length !== 0 ? (", " + fvals.join(", ")) : ""});`;
            }
        }
        else {
            const access = this.generateVFieldUpdate(op.arg, inferargtype, op.updates.map((upd) => [this.assembly.fieldDecls.get(upd[0]) as MIRFieldDecl, upd[1]]), resultAccessType);
            return `${this.varToCppName(op.trgt)} = ${access};`;
        }
    }

    generateVFieldExtend(arg: MIRArgument, infertype: MIRType, merge: MIRArgument, infermerge: MIRType, fieldResolves: [string, MIRFieldDecl][], resultAccessType: MIRType): string {
        const upnames = fieldResolves.map((fr) => `${fr[0]}->${fr[1].fkey}`);
        const mname = `merge_${infertype.trkey}_${upnames.join("*")}_with_${infermerge.trkey}`;
        let decl = this.vobjmerges.find((lookup) => lookup.mname === mname);
        if(decl === undefined) {
            this.vobjmerges.push({ infertype: infertype, merge: merge, infermergetype: infermerge, fieldResolves: fieldResolves, resultAccessType: resultAccessType, mname: mname });
        }

        return `${this.typegen.mangleStringForCpp(mname)}(${this.argToCpp(arg, infertype)}, ${this.argToCpp(merge, infermerge)})`;
    }

    generateMIRStructuredExtendObject(op: MIRStructuredExtendObject, resultAccessType: MIRType): string {
        const inferargtype = this.typegen.getMIRType(op.argInferType);
        const mergeargtype = this.typegen.getMIRType(op.updateInferType);

        if (this.typegen.typecheckUEntity(inferargtype)) {
            const ekey = this.typegen.getEntityEKey(inferargtype);
            const utype = this.typegen.assembly.entityDecls.get(ekey) as MIREntityTypeDecl;
            let cvals: [string, MIRType][] = [];
            for (let i = 0; i < utype.fields.length; ++i) {
                const fdecl = utype.fields[i];
                const ftype = this.typegen.getMIRType(fdecl.declaredType);

                const fp = op.fieldResolves.find((tfp) => tfp[1] === fdecl.fkey);
                const faccess = [`${this.argToCpp(op.arg, inferargtype)}->${this.typegen.mangleStringForCpp(fdecl.fkey)}`, ftype] as [string, MIRType];
                if(fp === undefined) {
                    cvals.push(faccess);
                }
                else {
                    const hasp = this.typegen.recordHasField(mergeargtype, fp[0]);
                    if(hasp === "no") {
                        cvals.push(faccess);
                    }
                    else if (hasp === "yes") {
                        cvals.push([this.generateMIRAccessFromPropertyExpression(op.arg, fp[0], ftype), ftype]);
                    }
                    else {
                        const check = this.generateMIRHasPropertyExpression(op.update, fp[0]);
                        const update = `(${check} ? ${this.generateMIRAccessFromPropertyExpression(op.update, fp[0], ftype)}) : ${faccess})`;

                        cvals.push([update, ftype]);
                    }
                }
            }

            const cppcrepr = this.typegen.getCPPReprFor(inferargtype);
            if (cppcrepr instanceof StructRepr) {
                const fvals = cvals.map((val) => {
                    return val[0];
                });

                return `${this.varToCppName(op.trgt)} = std::move(${cppcrepr.base}(${fvals.length !== 0 ? (", " + fvals.join(", ")) : ""}));`
            }
            else {
                const fvals = cvals.map((val) => {
                    return this.typegen.generateConstructorArgInc(val[1], val[0]);
                });

                const scopevar = this.varNameToCppName("$scope$");
                return `${this.varToCppName(op.trgt)} = BSQ_NEW_ADD_SCOPE(${scopevar}, ${cppcrepr.base}${fvals.length !== 0 ? (", " + fvals.join(", ")) : ""});`;
            }
        }
        else {
            const access = this.generateVFieldExtend(op.arg, inferargtype, op.update, mergeargtype, op.fieldResolves.map((fr) => [fr[0], this.assembly.fieldDecls.get(fr[1]) as MIRFieldDecl]), resultAccessType);
            return `${this.varToCppName(op.trgt)} = ${access};`;
        }
    }

    generateMIRLoadFromEpehmeralList(op: MIRLoadFromEpehmeralList): string {
        return `${this.varToCppName(op.trgt)} = ${this.varToCppName(op.arg)}.entry_${op.idx};`;
    }

    generateMIRInvokeFixedFunction(ivop: MIRInvokeFixedFunction): string {
        let vals: string[] = [];
        const idecl = (this.assembly.invokeDecls.get(ivop.mkey) || this.assembly.primitiveInvokeDecls.get(ivop.mkey)) as MIRInvokeDecl;

        for (let i = 0; i < ivop.args.length; ++i) {
            vals.push(this.argToCpp(ivop.args[i], this.typegen.getMIRType(idecl.params[i].type)));
        }

        const rtype = this.typegen.getMIRType(ivop.resultType);
        if (this.typegen.getRefCountableStatus(rtype) !== "no") {
            vals.push(this.varNameToCppName("$scope$"));
        }

        return `${this.varToCppName(ivop.trgt)} = ${this.invokenameToCPP(ivop.mkey)}(${vals.join(", ")});`;
    }

    generateEquals(op: string, lhsinfertype: MIRType, lhs: MIRArgument, rhsinfertype: MIRType, rhs: MIRArgument, isstrict: boolean): string {
        let coreop = "";
        if (isstrict) {
            const repr = this.typegen.getCPPReprFor(lhsinfertype);
            coreop = `EqualFunctor_${repr.base}{}(${this.argToCpp(lhs, lhsinfertype)}, ${this.argToCpp(rhs, rhsinfertype)})`;
        }
        else {
            coreop = `EqualFunctor_KeyValue{}(${this.argToCpp(lhs, this.typegen.keyType)}, ${this.argToCpp(rhs, this.typegen.keyType)})`;
        }

        return op === "!=" ? `!${coreop}` : coreop;
    }

    generateLess(lhsinfertype: MIRType, lhs: MIRArgument, rhsinfertype: MIRType, rhs: MIRArgument, isstrict: boolean): string {
        if (isstrict) {
            const repr = this.typegen.getCPPReprFor(lhsinfertype);
            return `LessFunctor_${repr.base}{}(${this.argToCpp(lhs, lhsinfertype)}, ${this.argToCpp(rhs, rhsinfertype)})`;
        }
        else {
            return `LessFunctor_KeyValue{}(${this.argToCpp(lhs, this.typegen.keyType)}, ${this.argToCpp(rhs, this.typegen.keyType)})`;
        }
    }

    generateCompare(op: string, lhsinfertype: MIRType, lhs: MIRArgument, rhsinfertype: MIRType, rhs: MIRArgument): string {
        if (op === "<") {
            return this.generateLess(lhsinfertype, lhs, rhsinfertype, rhs, true);
        }
        else if (op === "<=") {
            return `${this.generateLess(lhsinfertype, lhs, rhsinfertype, rhs, true)} || ${this.generateEquals("=", lhsinfertype, lhs, rhsinfertype, rhs, true)}`;
        }
        else if (op === ">") {
            return this.generateLess(rhsinfertype, rhs, lhsinfertype, lhs, true);
        }
        else {
            return `${this.generateLess(rhsinfertype, rhs, lhsinfertype, lhs, true)} || ${this.generateEquals("=", rhsinfertype, rhs, lhsinfertype, lhs, true)}`;
        }
    }

    generateSubtypeTupleCheck(argv: string, argtype: MIRType, oftype: MIRTupleType): string {
        const argrepr = this.typegen.getCPPReprFor(argtype);
        const subtypesig = `bool subtypeFROM_${this.typegen.mangleStringForCpp(argtype.trkey)}_TO_${this.typegen.mangleStringForCpp(oftype.trkey)}_TTC(${argrepr.std} arg)`;

        if (!this.subtypeFMap.has(subtypesig)) {
            const order = this.subtypeOrderCtr++;
            let ttuple = "";
            if (argrepr instanceof StructRepr) {
                ttuple = `BSQTuple* tt = &arg;`;
            }
            else {
                ttuple = `BSQTuple* tt = BSQ_GET_VALUE_PTR(arg, BSQTuple);`;
            }

            let checks: string[] = [];

            checks.push(`(tt->entries.size() <= ${oftype.entries.length})`);

            //do all the checks that argtype satisfies all the requirements of oftype -- maybe a bit inefficiently
            for (let i = 0; i < oftype.entries.length; ++i) {
                const chk = this.generateTypeCheck(`tt->atFixed<${i}>()`, this.typegen.anyType, this.typegen.anyType, oftype.entries[i].type);

                if(oftype.entries[i].isOptional) {
                    checks.push(`(!tt->hasIndex<${i}>() || ${chk})`);
                }
                else {
                    checks.push(`tt->hasIndex<${i}>()`);
                    checks.push(chk);
                }
            }

            let op = "";
            if (checks.includes("false")) {
                op = "false";
            }
            else {
                checks = checks.filter((chk) => chk !== "true");
                if(checks.length === 0) {
                    op = "true";
                }
                else if(checks.length === 1) {
                    op = checks[0];
                }
                else {
                    op = `(${checks.join(" && ")})`;
                }
            }

            const decl = subtypesig
            + "\n{\n"
            + `    ${ttuple}\n`
            + `    return ${op};\n`
            + `}\n`;

            this.subtypeFMap.set(subtypesig, { order: order, decl: decl });
        }

        return `subtypeFROM_${this.typegen.mangleStringForCpp(argtype.trkey)}_TO_${this.typegen.mangleStringForCpp(oftype.trkey)}_TTC(${argv})`;
    }

    generateTupleSpecialConceptCheck(argv: string, argtype: MIRType, oftype: MIRConceptType): string {
        const argrepr = this.typegen.getCPPReprFor(argtype);
        const subtypesig = `bool subtypeFROM_${this.typegen.mangleStringForCpp(argtype.trkey)}_TO_${this.typegen.mangleStringForCpp(oftype.trkey)}_TSC(${argrepr.std} arg)`;

        if (!this.subtypeFMap.has(subtypesig)) {
            const order = this.subtypeOrderCtr++;
            let ttuple = "";
            if (argrepr instanceof StructRepr) {
                ttuple = `BSQTuple* tt = &arg;`;
            }
            else {
                ttuple = `BSQTuple* tt = BSQ_GET_VALUE_PTR(arg, BSQTuple);`;
            }

            const checks: string[] = [];
            if (oftype.ckeys.some((cc) => this.typegen.assembly.subtypeOf(this.typegen.parsableType, this.typegen.getMIRType(cc)))) {
                checks.push(`DATA_KIND_PARSABLE_FLAG`);
            }

            if (oftype.ckeys.some((cc) => this.typegen.assembly.subtypeOf(this.typegen.podType, this.typegen.getMIRType(cc)))) {
                checks.push(`DATA_KIND_POD_FLAG`);
            }

            if (oftype.ckeys.some((cc) => this.typegen.assembly.subtypeOf(this.typegen.apiType, this.typegen.getMIRType(cc)))) {
                checks.push(`DATA_KIND_POD_FLAG`);
            }

            const decl = subtypesig
            + "\n{\n"
            + `    ${ttuple}\n`
            + `    DATA_KIND_FLAG cf = (${checks.join(" | ")});\n`
            + `    return cf == (cf & tt->flag);\n`
            + `}\n`;

            this.subtypeFMap.set(subtypesig, { order: order, decl: decl });
        }

        return `subtypeFROM_${this.typegen.mangleStringForCpp(argtype.trkey)}_TO_${this.typegen.mangleStringForCpp(oftype.trkey)}_TSC(${argv})`;
    }

    generateSubtypeRecordCheck(argv: string, argtype: MIRType, oftype: MIRRecordType): string {
        const argrepr = this.typegen.getCPPReprFor(argtype);
        const subtypesig = `bool subtypeFROM_${this.typegen.mangleStringForCpp(argtype.trkey)}_TO_${this.typegen.mangleStringForCpp(oftype.trkey)}_TRC(${argrepr.std} arg)`;

        if (!this.subtypeFMap.has(subtypesig)) {
            const order = this.subtypeOrderCtr++;
            let trecord = "";
            if (argrepr instanceof StructRepr) {
                trecord = `BSQRecord* tr = &arg;`;
            }
            else {
                trecord = `BSQRecord* tr = BSQ_GET_VALUE_PTR(arg, BSQRecord);`;
            }

            let checks: string[] = [];

            //do all the checks that argtype satisfies all the requirements of oftype -- maybe a bit inefficiently
            for (let i = 0; i < oftype.entries.length; ++i) {
                const pname = oftype.entries[i].name;
                const chk = this.generateTypeCheck(`tr->atFixed<MIRPropertyEnum::${pname}>()`, this.typegen.anyType, this.typegen.anyType, oftype.entries[i].type);

                if (oftype.entries[i].isOptional) {
                    checks.push(`(!tr->hasProperty<MIRPropertyEnum::${pname}>() || ${chk})`);
                }
                else {
                    checks.push(`tr->hasProperty<MIRPropertyEnum::${pname}>()`);
                    checks.push(chk);
                }
            }

            //do checks that argtype doesn't have any other properties
            if (this.typegen.typecheckRecord(argtype)) {
                const allprops = this.typegen.getMaxPropertySet(argtype);

                for (let i = 0; i < allprops.length; ++i) {
                    const pname = allprops[i];
                    if (oftype.entries.find((entry) => entry.name === pname) === undefined) {
                        checks.push(`!tr->hasProperty<MIRPropertyEnum::${pname}>()`);
                    }
                }
            }
            else {
                const pprops = oftype.entries.map((entry) => `MIRPropertyEnum::${entry.name}`);
                checks.push(`tr->checkPropertySet(${oftype.entries.length}${oftype.entries.length !== 0 ? ", " : ""} ${pprops.join(", ")})`);
            }

            let op = "";
            if (checks.includes("false")) {
                op = "false";
            }
            else {
                checks = checks.filter((chk) => chk !== "true");
                if(checks.length === 0) {
                    op = "true";
                }
                else if(checks.length === 1) {
                    op = checks[0];
                }
                else {
                    op = `(${checks.join(" && ")})`;
                }
            }

            const decl = subtypesig
            + "\n{\n"
            + `    ${trecord}\n`
            + `    return ${op};\n`
            + `}\n`;

            this.subtypeFMap.set(subtypesig, { order: order, decl: decl });
        }

        return `subtypeFROM_${this.typegen.mangleStringForCpp(argtype.trkey)}_TO_${this.typegen.mangleStringForCpp(oftype.trkey)}_TRC(${argv})`;
    }

    generateRecordSpecialConceptCheck(argv: string, argtype: MIRType, oftype: MIRConceptType): string {
        const argrepr = this.typegen.getCPPReprFor(argtype);
        const subtypesig = `bool subtypeFROM_${this.typegen.mangleStringForCpp(argtype.trkey)}_TO_${this.typegen.mangleStringForCpp(oftype.trkey)}_RSC(${argrepr.std} arg)`;

        if (!this.subtypeFMap.has(subtypesig)) {
            const order = this.subtypeOrderCtr++;
            let ttuple = "";
            if (argrepr instanceof StructRepr) {
                ttuple = `BSQRecord* tr = &arg;`;
            }
            else {
                ttuple = `BSQRecord* tr = BSQ_GET_VALUE_PTR(arg, BSQRecord);`;
            }

            const checks: string[] = [];
            if (oftype.ckeys.some((cc) => this.typegen.assembly.subtypeOf(this.typegen.parsableType, this.typegen.getMIRType(cc)))) {
                checks.push(`DATA_KIND_PARSABLE_FLAG`);
            }

            if (oftype.ckeys.some((cc) => this.typegen.assembly.subtypeOf(this.typegen.podType, this.typegen.getMIRType(cc)))) {
                checks.push(`DATA_KIND_POD_FLAG`);
            }

            if (oftype.ckeys.some((cc) => this.typegen.assembly.subtypeOf(this.typegen.apiType, this.typegen.getMIRType(cc)))) {
                checks.push(`DATA_KIND_POD_FLAG`);
            }

            const decl = subtypesig
            + "\n{\n"
            + `    ${ttuple}\n`
            + `    DATA_KIND_FLAG cf = (${checks.join(" | ")});\n`
            + `    return cf == (cf & tr->flag);\n`
            + `}\n`;

            this.subtypeFMap.set(subtypesig, { order: order, decl: decl });
        }

        return `subtypeFROM_${this.typegen.mangleStringForCpp(argtype.trkey)}_TO_${this.typegen.mangleStringForCpp(oftype.trkey)}_RSC(${argv})`;
    }

    generateFastTupleTypeCheck(arg: string, argtype: MIRType, inferargtype: MIRType, oftype: MIRTupleType): string {
        if (!inferargtype.options.some((opt) => opt instanceof MIRTupleType)) {
            return "false";
        }
        else {
            const argrepr = this.typegen.getCPPReprFor(argtype);
            const tsc = this.generateSubtypeTupleCheck(arg, argtype, oftype);

            if (argrepr instanceof StructRepr) {
                return tsc;
            }
            else {
                return `(BSQ_IS_VALUE_PTR(${arg}) && dynamic_cast<BSQTuple*>(BSQ_GET_VALUE_PTR(${arg}, BSQRef)) != nullptr && ${tsc})`;
            }
        }
    }

    generateFastRecordTypeCheck(arg: string, argtype: MIRType, inferargtype: MIRType, oftype: MIRRecordType): string {
        if (!inferargtype.options.some((opt) => opt instanceof MIRRecordType)) {
            return "false";
        }
        else {
            const argrepr = this.typegen.getCPPReprFor(argtype);
            const tsc = this.generateSubtypeTupleCheck(arg, argtype, oftype);

            if (argrepr instanceof StructRepr) {
                return tsc;
            }
            else {
                return `(BSQ_IS_VALUE_PTR(${arg}) && dynamic_cast<BSQRecord*>(BSQ_GET_VALUE_PTR(${arg}, BSQRef)) != nullptr && ${tsc})`;
            }
        }
    }

    generateSubtypeArrayLookup(typeenum: string, oftype: MIRConceptType): string {
        this.checkedConcepts.add(oftype.trkey);
        const arraystr = `MIRConceptSubtypeArray__${this.typegen.mangleStringForCpp(oftype.trkey)}`;
        return `BSQObject::checkSubtype(${typeenum}, ${arraystr})`;
    }

    generateFastConceptTypeCheck(arg: string, argtype: MIRType, inferargtype: MIRType, oftype: MIRConceptType): string {
        if (this.typegen.typecheckIsName(inferargtype, /^NSCore::None$/) || this.typegen.typecheckUEntity(inferargtype)) {
            return this.typegen.assembly.subtypeOf(inferargtype, this.typegen.getMIRType(oftype.trkey)) ? "true" : "false";
        }
        else {
            let enumacc = "";
            if (this.typegen.typecheckTuple(inferargtype)) {
                enumacc = "MIRNominalTypeEnum_Tuple";
            }
            else if (this.typegen.typecheckRecord(inferargtype)) {
                enumacc = "MIRNominalTypeEnum_Record";
            }
            else {
                const argrepr = this.typegen.getCPPReprFor(argtype);
                if (argrepr instanceof KeyValueRepr) {
                    enumacc = `getNominalTypeOf_KeyValue(${arg})`;
                }
                else {
                    enumacc = `getNominalTypeOf_Value(${arg})`;
                }
            }

            let ttest = "false";
            if (inferargtype.options.some((iopt) => iopt instanceof MIRTupleType)) {
                const tupmax = MIRType.createSingle(MIRConceptType.create([this.typegen.tupleType.trkey, this.typegen.podType.trkey, this.typegen.parsableType.trkey]));
                const maybespecial = this.typegen.assembly.subtypeOf(tupmax, this.typegen.getMIRType(oftype.trkey)); //if this isn't true then special subtype will never be true
                const trival = this.typegen.assembly.subtypeOf(this.typegen.tupleType, this.typegen.getMIRType(oftype.trkey)); //if this is true then the default subtypeArray is enough
                if (maybespecial && !trival) {
                   ttest = `(enumacc == MIRNominalTypeEnum_Tuple) && ${this.generateTupleSpecialConceptCheck(arg, argtype, oftype)}`;
                }
            }

            let rtest = "false";
            if (inferargtype.options.some((iopt) => iopt instanceof MIRRecordType)) {
                const recmax = MIRType.createSingle(MIRConceptType.create([this.typegen.recordType.trkey, this.typegen.podType.trkey, this.typegen.parsableType.trkey]));
                const maybespecial = this.typegen.assembly.subtypeOf(recmax, this.typegen.getMIRType(oftype.trkey)); //if this isn't true then special subtype will never be true
                const trival = this.typegen.assembly.subtypeOf(this.typegen.recordType, this.typegen.getMIRType(oftype.trkey)); //if this is true then the default subtypeArray is enough
                if (maybespecial && !trival) {
                    rtest = `(enumacc == MIRNominalTypeEnum_Record) && ${this.generateRecordSpecialConceptCheck(arg, argtype, oftype)})`;
                }
            }

            const ntest = this.generateSubtypeArrayLookup(enumacc, oftype);

            const tests = [ntest, ttest, rtest].filter((test) => test !== "false");

            if (tests.length === 0) {
                return "false";
            }
            else if (tests.includes("true")) {
                return "true";
            }
            else if (tests.length === 1) {
                return tests[0];
            }
            else {
                return `(${tests.join(" || ")})`
            }
        }
    }

    generateFastEntityTypeCheck(arg: string, argtype: MIRType, inferargtype: MIRType, oftype: MIREntityType): string {
        if (this.typegen.typecheckIsName(inferargtype, /^NSCore::None$/) || this.typegen.typecheckUEntity(inferargtype)) {
            return inferargtype.trkey == oftype.trkey ? "true" : "false";
        }
        else {
            const argrepr = this.typegen.getCPPReprFor(argtype);

            if (argrepr instanceof StructRepr) {
                //could be a tuple or record
                return "false";
            }
            else if (argrepr instanceof KeyValueRepr) {
                return `(getNominalTypeOf_KeyValue(${arg}) == MIRNominalTypeEnum::${this.typegen.mangleStringForCpp(oftype.ekey)})`;
            }
            else {
                return `(getNominalTypeOf_Value(${arg}) == MIRNominalTypeEnum::${this.typegen.mangleStringForCpp(oftype.ekey)})`;
            }
        }
    }

    generateEphemeralTypeCheck(argv: string, argtype: MIRType, oftype: MIREphemeralListType): string {
        const argrepr = this.typegen.getCPPReprFor(argtype);
        const subtypesig = `bool subtypeFROM_${this.typegen.mangleStringForCpp(argtype.trkey)}_TO_${this.typegen.mangleStringForCpp(oftype.trkey)}_EL(${argrepr.std} arg)`;

        if (!this.subtypeFMap.has(subtypesig)) {
            const order = this.subtypeOrderCtr++;
            let checks: string[] = [];

            //do all the checks that argtype satisfies all the requirements of oftype
            for (let i = 0; i < oftype.entries.length; ++i) {
                const etype = (argtype.options[0] as MIREphemeralListType).entries[i];
                checks.push(this.generateTypeCheck(`arg.entry_${i}`, etype, etype, oftype.entries[i]));
            }

            let op = "";
            if (checks.includes("false")) {
                op = "false";
            }
            else {
                checks = checks.filter((chk) => chk !== "true");
                if(checks.length === 0) {
                    op = "true";
                }
                else if(checks.length === 1) {
                    op = checks[0];
                }
                else {
                    op = `(${checks.join(" && ")})`;
                }
            }

            const decl = subtypesig
            + "\n{\n"
            + `    return ${op};\n`
            + `}\n`;

            this.subtypeFMap.set(subtypesig, { order: order, decl: decl });
        }

        return `subtypeFROM_${this.typegen.mangleStringForCpp(argtype.trkey)}_TO_${this.typegen.mangleStringForCpp(oftype.trkey)}_EL(${argv})`;
    }

    generateTypeCheck(arg: string, argtype: MIRType, inferargtype: MIRType, oftype: MIRType): string {
        if(this.typegen.assembly.subtypeOf(inferargtype, oftype)) {
            //this case also include oftype == Any
            return "true";
        }
        const argrepr = this.typegen.getCPPReprFor(argtype);

        if(oftype.trkey === "NSCore::Some") {
            if(!this.typegen.assembly.subtypeOf(this.typegen.noneType, inferargtype)) {
                return "true";
            }
            else {
                if (argrepr instanceof NoneRepr) {
                    return "false";
                }
                else if (argrepr instanceof RefRepr || argrepr instanceof StructRepr) {
                    return "true";
                }
                else {
                    return `BSQ_IS_VALUE_NONNONE(${arg})`;
                }
            }
        }

        const tests = oftype.options.map((topt) => {
            const mtype = this.typegen.getMIRType(topt.trkey);
            assert(mtype !== undefined, "We should generate all the component types by default??");

            if(topt instanceof MIREntityType) {
                return this.generateFastEntityTypeCheck(arg, argtype, inferargtype, topt);
            }
            else if (topt instanceof MIRConceptType) {
                return this.generateFastConceptTypeCheck(arg, argtype, inferargtype, topt);
            }
            else if (topt instanceof MIRTupleType) {
                return this.generateFastTupleTypeCheck(arg, argtype, inferargtype, topt);
            }
            else if (topt instanceof MIRRecordType) {
                return this.generateFastRecordTypeCheck(arg, argtype, inferargtype, topt);
            }
            else {
                assert(topt instanceof MIREphemeralListType);

                return this.generateEphemeralTypeCheck(arg, argtype, topt as MIREphemeralListType);
            }
        })
        .filter((test) => test !== "false");

        if(tests.length === 0) {
            return "false";
        }
        else if(tests.includes("true")) {
            return "true";
        }
        else if(tests.length === 1) {
            return tests[0];
        }
        else {
            return `(${tests.join(" || ")})`
        }
    }

    generateMIRPackSlice(op: MIRPackSlice): string {
        const etype = this.typegen.getMIRType(op.sltype).options[0] as MIREphemeralListType;

        let args: string[] = [];
        for(let i = 0; i < etype.entries.length; ++i) {
            args.push(`${this.varToCppName(op.src)}.entry_${i}`);
        }

        return `${this.varToCppName(op.trgt)} = ${this.typegen.mangleStringForCpp(etype.trkey)}{${args.join(", ")}};`;
    }

    generateMIRPackSliceExtend(op: MIRPackExtend): string {
        const fromtype = this.getArgType(op.basepack).options[0] as MIREphemeralListType;
        const etype = this.typegen.getMIRType(op.sltype).options[0] as MIREphemeralListType;

        let args: string[] = [];
        for(let i = 0; i < fromtype.entries.length; ++i) {
            args.push(`${this.varToCppName(op.basepack)}.entry_${i}`);
        }

        for(let i = 0; i < op.ext.length; ++i) {
            args.push(this.argToCpp(op.ext[i], etype.entries[fromtype.entries.length + i]));
        }

        return `${this.varToCppName(op.trgt)} = ${this.typegen.mangleStringForCpp(etype.trkey)}{${args.join(", ")}};`;
    }

    generateStmt(op: MIROp): string | undefined {
        switch (op.tag) {
            case MIROpTag.MIRLoadConst: {
                const lcv = op as MIRLoadConst;
                return `${this.varToCppName(lcv.trgt)} = ${this.generateConstantExp(lcv.src, this.getArgType(lcv.trgt))};`;
            }
            case MIROpTag.MIRLoadConstSafeString: {
                return this.generateLoadConstSafeString(op as MIRLoadConstSafeString);
            }
            case MIROpTag.MIRLoadConstTypedString:  {
                return this.generateLoadConstTypedString(op as MIRLoadConstTypedString);
            }
            case MIROpTag.MIRAccessConstantValue: {
                const acv = (op as MIRAccessConstantValue);
                return this.generateAccessConstantValue(acv);
            }
            case MIROpTag.MIRLoadFieldDefaultValue: {
                const ldv = (op as MIRLoadFieldDefaultValue);
                return this.generateLoadFieldDefaultValue(ldv);
            }
            case MIROpTag.MIRAccessArgVariable: {
                const lav = op as MIRAccessArgVariable;
                return `${this.varToCppName(lav.trgt)} = ${this.argToCpp(lav.name, this.getArgType(lav.trgt))};`;
            }
            case MIROpTag.MIRAccessLocalVariable: {
                const llv = op as MIRAccessLocalVariable;
                return `${this.varToCppName(llv.trgt)} = ${this.argToCpp(llv.name, this.getArgType(llv.trgt))};`;
            }
            case MIROpTag.MIRInvokeInvariantCheckDirect: {
                const icd = op as MIRInvokeInvariantCheckDirect;
                return this.generateMIRInvokeInvariantCheckDirect(icd);
            }
            case MIROpTag.MIRInvokeInvariantCheckVirtualTarget: {
                return NOT_IMPLEMENTED<string>("MIRInvokeInvariantCheckVirtualTarget");
            }
            case MIROpTag.MIRConstructorPrimary: {
                const cp = op as MIRConstructorPrimary;
                return this.generateMIRConstructorPrimary(cp);
            }
            case MIROpTag.MIRConstructorPrimaryCollectionEmpty: {
                const cpce = op as MIRConstructorPrimaryCollectionEmpty;
                return this.generateMIRConstructorPrimaryCollectionEmpty(cpce);
            }
            case MIROpTag.MIRConstructorPrimaryCollectionSingletons: {
                const cpcs = op as MIRConstructorPrimaryCollectionSingletons;
                return this.generateMIRConstructorPrimaryCollectionSingletons(cpcs);
            }
            case MIROpTag.MIRConstructorPrimaryCollectionCopies: {
                return NOT_IMPLEMENTED<string>("MIRConstructorPrimaryCollectionCopies");
            }
            case MIROpTag.MIRConstructorPrimaryCollectionMixed: {
                return NOT_IMPLEMENTED<string>("MIRConstructorPrimaryCollectionMixed");
            }
            case MIROpTag.MIRConstructorTuple: {
                return this.generateMIRConstructorTuple(op as MIRConstructorTuple);
            }
            case MIROpTag.MIRConstructorRecord: {
               return this.generateMIRConstructorRecord(op as MIRConstructorRecord);
            }
            case MIROpTag.MIRConstructorEphemeralValueList: {
                return this.generateMIRConstructorEphemeralValueList(op as MIRConstructorEphemeralValueList);
            }
            case MIROpTag.MIRAccessFromIndex: {
                const ai = op as MIRAccessFromIndex;
                return `${this.varToCppName(ai.trgt)} = ${this.generateMIRAccessFromIndexExpression(ai.arg, ai.idx, this.typegen.getMIRType(ai.resultAccessType))};`;
            }
            case MIROpTag.MIRProjectFromIndecies: {
                const pi = op as MIRProjectFromIndecies;
                return this.generateMIRProjectFromIndecies(pi, this.typegen.getMIRType(pi.resultProjectType));
            }
            case MIROpTag.MIRAccessFromProperty: {
                const ap = op as MIRAccessFromProperty;
                return `${this.varToCppName(ap.trgt)} = ${this.generateMIRAccessFromPropertyExpression(ap.arg, ap.property, this.typegen.getMIRType(ap.resultAccessType))};`;
            }
            case MIROpTag.MIRProjectFromProperties: {
                const pp = op as MIRProjectFromProperties;
                return this.generateMIRProjectFromProperties(pp, this.typegen.getMIRType(pp.resultProjectType));
            }
            case MIROpTag.MIRAccessFromField: {
                const af = op as MIRAccessFromField;
                return this.generateMIRAccessFromField(af, this.typegen.getMIRType(af.resultAccessType));
            }
            case MIROpTag.MIRProjectFromFields: {
                const pf = op as MIRProjectFromFields;
                return this.generateMIRProjectFromFields(pf, this.typegen.getMIRType(pf.resultProjectType));
            }
            case MIROpTag.MIRProjectFromTypeTuple: {
                return NOT_IMPLEMENTED<string>("MIRProjectFromTypeTuple");
            }
            case MIROpTag.MIRProjectFromTypeRecord: {
                return NOT_IMPLEMENTED<string>("MIRProjectFromTypeRecord");
            }
            case MIROpTag.MIRProjectFromTypeNominal: {
                return NOT_IMPLEMENTED<string>("MIRProjectFromTypeNominal");
            }
            case MIROpTag.MIRModifyWithIndecies: {
                const mi = op as MIRModifyWithIndecies;
                return this.generateMIRModifyWithIndecies(mi, this.typegen.getMIRType(mi.resultTupleType));
            }
            case MIROpTag.MIRModifyWithProperties: {
                const mp = op as MIRModifyWithProperties;
                return this.generateMIRModifyWithProperties(mp, this.typegen.getMIRType(mp.resultRecordType));
            }
            case MIROpTag.MIRModifyWithFields: {
                const mf = op as MIRModifyWithFields;
                return this.generateMIRModifyWithFields(mf, this.typegen.getMIRType(mf.resultNominalType));
            }
            case MIROpTag.MIRStructuredExtendTuple: {
                const si = op as MIRStructuredExtendTuple;
                return this.generateMIRStructuredExtendTuple(si, this.typegen.getMIRType(si.resultTupleType));
            }
            case MIROpTag.MIRStructuredExtendRecord: {
                const sp = op as MIRStructuredExtendRecord;
                return this.generateMIRStructuredExtendRecord(sp, this.typegen.getMIRType(sp.resultRecordType));
            }
            case MIROpTag.MIRStructuredExtendObject: {
                const so = op as MIRStructuredExtendObject;
                return this.generateMIRStructuredExtendObject(so, this.typegen.getMIRType(so.resultNominalType));
            }
            case MIROpTag.MIRLoadFromEpehmeralList: {
                const le = op as MIRLoadFromEpehmeralList;
                return this.generateMIRLoadFromEpehmeralList(le);
            }
            case MIROpTag.MIRInvokeFixedFunction: {
                const invk = op as MIRInvokeFixedFunction;
                return this.generateMIRInvokeFixedFunction(invk);
            }
            case MIROpTag.MIRInvokeVirtualTarget: {
                return NOT_IMPLEMENTED<string>("MIRInvokeVirtualTarget");
            }
            case MIROpTag.MIRPrefixOp: {
                const pfx = op as MIRPrefixOp;
                if (pfx.op === "!") {
                    return `${this.varToCppName(pfx.trgt)} = !${this.argToCpp(pfx.arg, this.typegen.boolType)};`;
                }
                else {
                    if (pfx.op === "-") {
                        if (pfx.arg instanceof MIRConstantInt) {
                            return `${this.varToCppName(pfx.trgt)} = -${(pfx.arg as MIRConstantInt).value};`;
                        }
                        else if (pfx.arg instanceof MIRConstantBigInt) {
                            const scope = this.typegen.mangleStringForCpp("$scope$");
                            return `${this.varToCppName(pfx.trgt)} = BSQ_NEW_ADD_SCOPE(${scope}, BSQBigInt, "-${(pfx.arg as MIRConstantBigInt).digits()}");`;
                        }
                        else if (pfx.arg instanceof MIRConstantFloat64) {
                            return `${this.varToCppName(pfx.trgt)} = -${(pfx.arg as MIRConstantFloat64).digits()};`;
                        }
                        else {
                            const opt = this.typegen.getMIRType(pfx.infertype);

                            if (this.typegen.typecheckIsName(opt, /^NSCore::Int$/)) {
                                return `${this.varToCppName(pfx.trgt)} = -${this.argToCpp(pfx.arg, this.typegen.intType)};`;
                            }
                            else if (this.typegen.typecheckIsName(opt, /^NSCore::BigInt$/)) {
                                const scope = this.typegen.mangleStringForCpp("$scope$");
                                return `${this.varToCppName(pfx.trgt)} = BSQBigInt::negate(${scope}, ${this.argToCpp(pfx.arg, this.typegen.bigIntType)});`;
                            }
                            else {
                                return `${this.varToCppName(pfx.trgt)} = -${this.argToCpp(pfx.arg, this.typegen.float64Type)};`;
                            }
                        }
                    }
                    else {
                        return `${this.varToCppName(pfx.trgt)} = ${this.argToCpp(pfx.arg, this.getArgType(pfx.trgt))};`;
                    }
                }
            }
            case MIROpTag.MIRBinOp: {
                const bop = op as MIRBinOp;
                const opt = this.typegen.getMIRType(bop.lhsInferType);

                if (this.typegen.typecheckIsName(opt, /^NSCore::Int$/)) {
                    if(bop.op !== "/") {
                        const chkedop = new Map<string, string>().set("+", "__builtin_add_overflow").set("-", "__builtin_sub_overflow").set("*", "__builtin_mul_overflow").get(bop.op) as string;
                        const opp = `if(${chkedop}(${this.argToCpp(bop.lhs, this.typegen.intType)}, ${this.argToCpp(bop.rhs, this.typegen.intType)}, &${this.varToCppName(bop.trgt)}) || INT_OOF_BOUNDS(${this.varToCppName(bop.trgt)})) { BSQ_ABORT("Int Overflow", "${filenameClean(this.currentFile)}", ${bop.sinfo.line}); }`;
                        return opp;
                    }
                    else {
                        const chk = `if(${this.argToCpp(bop.rhs, this.typegen.intType)} == 0) { BSQ_ABORT("Div by 0", "${filenameClean(this.currentFile)}", ${bop.sinfo.line}); }`;
                        const opp = `${this.varToCppName(bop.trgt)} = ${this.argToCpp(bop.lhs, this.typegen.intType)} / ${this.argToCpp(bop.rhs, this.typegen.intType)};`;

                        return chk + " " + opp;
                    }
                }
                else if (this.typegen.typecheckIsName(opt, /^NSCore::BigInt$/)) {
                    const bigop = new Map<string, string>().set("+", "add").set("-", "sub").set("*", "mult").set("/", "div").get(bop.op) as string;
                    const opp = `${this.varToCppName(bop.trgt)} = BSQBigInt::${bigop}(${this.argToCpp(bop.lhs, this.typegen.bigIntType)}, ${this.argToCpp(bop.rhs, this.typegen.bigIntType)});`;
                    if(bop.op !== "/") {
                        return opp;
                    }
                    else {
                        const chk = `if(${this.argToCpp(bop.rhs, this.typegen.bigIntType)}->eqI64(0)) { BSQ_ABORT("Div by 0", "${filenameClean(this.currentFile)}", ${bop.sinfo.line}); }`;
                        return chk + " " + opp;
                    }
                }
                else {
                    return `${this.varToCppName(bop.trgt)} = ${this.argToCpp(bop.lhs, this.typegen.float64Type)} ${bop.op} ${this.argToCpp(bop.rhs, this.typegen.float64Type)};`;
                }
            }
            case MIROpTag.MIRBinEq: {
                const beq = op as MIRBinEq;

                const lhvtypeinfer = this.typegen.getMIRType(beq.lhsInferType);
                const rhvtypeinfer = this.typegen.getMIRType(beq.rhsInferType);
                return `${this.varToCppName(beq.trgt)} = ${this.generateEquals(beq.op, lhvtypeinfer, beq.lhs, rhvtypeinfer, beq.rhs, !beq.relaxed)};`;
            }
            case MIROpTag.MIRBinLess: {
                const blt = op as MIRBinLess;

                const lhvtypeinfer = this.typegen.getMIRType(blt.lhsInferType);
                const rhvtypeinfer = this.typegen.getMIRType(blt.rhsInferType);
                return `${this.varToCppName(blt.trgt)} = ${this.generateLess(lhvtypeinfer, blt.lhs, rhvtypeinfer, blt.rhs, !blt.relaxed)};`;
            }
            case MIROpTag.MIRBinCmp: {
                const bcmp = op as MIRBinCmp;

                const lhvtypeinfer = this.typegen.getMIRType(bcmp.lhsInferType);
                const rhvtypeinfer = this.typegen.getMIRType(bcmp.rhsInferType);
                return `${this.varToCppName(bcmp.trgt)} = ${this.generateCompare(bcmp.op, lhvtypeinfer, bcmp.lhs, rhvtypeinfer, bcmp.rhs)};`;
            }
            case MIROpTag.MIRIsTypeOfNone: {
                const ton = op as MIRIsTypeOfNone;
                return `${this.varToCppName(ton.trgt)} = ${this.generateNoneCheck(ton.arg)};`;
            }
            case MIROpTag.MIRIsTypeOfSome: {
                const tos = op as MIRIsTypeOfSome;
                return `${this.varToCppName(tos.trgt)} = !${this.generateNoneCheck(tos.arg)};`;
           }
            case MIROpTag.MIRIsTypeOf: {
                const top = op as MIRIsTypeOf;
                const oftype = this.typegen.getMIRType(top.oftype);
                const argtype = this.getArgType(top.arg);
                const infertype = this.typegen.getMIRType(top.argInferType);

                return `${this.varToCppName(top.trgt)} = ${this.generateTypeCheck(this.argToCpp(top.arg, argtype), argtype, infertype, oftype)};`;
            }
            case MIROpTag.MIRRegAssign: {
                const regop = op as MIRRegAssign;
                return `${this.varToCppName(regop.trgt)} = ${this.argToCpp(regop.src, this.getArgType(regop.trgt))};`;
            }
            case MIROpTag.MIRTruthyConvert: {
                const tcop = op as MIRTruthyConvert;
                return `${this.varToCppName(tcop.trgt)} = ${this.generateTruthyConvert(tcop.src)};`;
            }
            case MIROpTag.MIRVarStore: {
                const vsop = op as MIRVarStore;
                return `${this.varToCppName(vsop.name)} = ${this.argToCpp(vsop.src, this.getArgType(vsop.name))};`;
            }
            case MIROpTag.MIRPackSlice: {
                const vps = op as MIRPackSlice;
                return this.generateMIRPackSlice(vps);
            }
            case MIROpTag.MIRPackExtend: {
                const vpe = op as MIRPackExtend;
                return this.generateMIRPackSliceExtend(vpe);
            }
            case MIROpTag.MIRReturnAssign: {
                const raop = op as MIRReturnAssign;
                return `${this.varToCppName(raop.name)} = ${this.argToCpp(raop.src, this.getArgType(raop.name))};`;
            }
            case MIROpTag.MIRAbort: {
                const aop = (op as MIRAbort);
                return `BSQ_ABORT("${aop.info}", "${filenameClean(this.currentFile)}", ${aop.sinfo.line});`;
            }
            case MIROpTag.MIRDebug: {
                //debug is a nop in AOT release mode but we allow it for our debugging purposes
                const dbgop = op as MIRDebug;
                if (dbgop.value === undefined) {
                    return "assert(false);";
                }
                else {
                    return `{ std::cout << diagnostic_format(${this.argToCpp(dbgop.value, this.typegen.anyType)}) << "\\n"; }`;
                }
            }
            case MIROpTag.MIRJump: {
                const jop = op as MIRJump;
                return `goto ${this.labelToCpp(jop.trgtblock)};`;
            }
            case MIROpTag.MIRJumpCond: {
                const cjop = op as MIRJumpCond;
                return `if(${this.argToCpp(cjop.arg, this.typegen.boolType)}) {goto ${this.labelToCpp(cjop.trueblock)};} else {goto ${cjop.falseblock};}`;
            }
            case MIROpTag.MIRJumpNone: {
                const njop = op as MIRJumpNone;
                return `if(${this.generateNoneCheck(njop.arg)}) {goto ${this.labelToCpp(njop.noneblock)};} else {goto ${njop.someblock};}`;
            }
            case MIROpTag.MIRPhi: {
                return undefined; //handle this as a special case in the block processing code
            }
            case MIROpTag.MIRVarLifetimeStart:
            case MIROpTag.MIRVarLifetimeEnd: {
                return undefined;
            }
            default: {
                return NOT_IMPLEMENTED<string>(`Missing case ${op.tag}`);
            }
        }
    }

    generateBlock(block: MIRBasicBlock) {
        let gblock: string[] = [];

        let blocki = 0;
        while (blocki < block.ops.length - 1 && block.ops[blocki] instanceof MIRPhi) {
            const phiop = block.ops[blocki] as MIRPhi;
            phiop.src.forEach((src, fblock) => {
                const assign = `${this.varToCppName(phiop.trgt)} = ${this.argToCpp(src, this.getArgType(phiop.trgt))};`;
                const inblock = this.generatedBlocks.get(fblock) as string[];

                //last entry is the jump so put before that but after all other statements
                const jmp = inblock[inblock.length - 1];
                inblock[inblock.length - 1] = assign;
                inblock.push(jmp);
            });

            ++blocki;
        }

        while (blocki < block.ops.length) {
            const gop = this.generateStmt(block.ops[blocki]);
            if (gop !== undefined) {
                gblock.push(gop);
            }

            ++blocki;
        }

        if (block.label === "exit") {
            const rctype = this.typegen.getRefCountableStatus(this.currentRType);
            if(rctype !== "no") {
                gblock.push(this.typegen.buildReturnOpForType(this.currentRType, "$$return", "$callerscope$") + ";");
            }

            gblock.push("return $$return;");
        }

        this.generatedBlocks.set(block.label, gblock);
    }

    generateCPPVarDecls(body: MIRBody, params: MIRFunctionParameter[]): string {
        const scopevar = this.varNameToCppName("$scope$");
        const refscope = `    BSQRefScope ${scopevar};`;

        let vdecls = new Map<string, string[]>();
        (body.vtypes as Map<string, string>).forEach((tkey, name) => {
            if (params.findIndex((p) => p.name === name) === -1) {
                const declt = this.typegen.getCPPReprFor(this.typegen.getMIRType(tkey)).std;
                if (!vdecls.has(declt)) {
                    vdecls.set(declt, [] as string[]);
                }

                (vdecls.get(declt) as string[]).push(this.varNameToCppName(name));
            }
        });
        let vdeclscpp: string[] = [];
        if (vdecls.has("BSQBool")) {
            vdeclscpp.push(`BSQBool ${(vdecls.get("BSQBool") as string[]).join(", ")};`);
        }
        if (vdecls.has("int64_t")) {
            vdeclscpp.push(`int64_t ${(vdecls.get("int64_t") as string[]).join(", ")};`);
        }
        [...vdecls].sort((a, b) => a[0].localeCompare(b[0])).forEach((kv) => {
            if (kv[0] !== "BSQBool" && kv[0] !== "int64_t") {
                vdeclscpp.push(kv[1].map((vname) => `${kv[0]} ${vname}`).join("; ") + ";");
            }
        });

        return [refscope, ...vdeclscpp].join("\n    ");
    }

    generateCPPInvoke(idecl: MIRInvokeDecl): { fwddecl: string, fulldecl: string } {
        this.currentFile = idecl.srcFile;
        this.currentRType = this.typegen.getMIRType(idecl.resultType);

        const args = idecl.params.map((arg) => `${this.typegen.getCPPReprFor(this.typegen.getMIRType(arg.type)).std} ${this.varNameToCppName(arg.name)}`);
        const restype = this.typegen.getCPPReprFor(this.typegen.getMIRType(idecl.resultType)).std;

        if (this.typegen.getRefCountableStatus(this.typegen.getMIRType(idecl.resultType)) !== "no") {
                args.push(`BSQRefScope& $callerscope$`);
        }
        const decl = `${restype} ${this.invokenameToCPP(idecl.key)}(${args.join(", ")})`;

        if (idecl instanceof MIRInvokeBodyDecl) {
            this.vtypes = new Map<string, MIRType>();
            (idecl.body.vtypes as Map<string, string>).forEach((tkey, name) => {
                this.vtypes.set(name, this.assembly.typeMap.get(tkey) as MIRType);
            });

            this.generatedBlocks = new Map<string, string[]>();

            const blocks = topologicalOrder((idecl as MIRInvokeBodyDecl).body.body);
            for (let i = 0; i < blocks.length; ++i) {
                this.generateBlock(blocks[i]);
            }

            const blockstrs = [...this.generatedBlocks].map((blck) => {
                const lbl = `${this.labelToCpp(blck[0])}:\n`;
                const stmts = blck[1].map((stmt) => "    " + stmt).join("\n");

                if (lbl.startsWith("entry:")) {
                    return stmts;
                }
                else {
                    return lbl + stmts;
                }
            });

            const scopestrs = this.generateCPPVarDecls(idecl.body, idecl.params);

            return { fwddecl: decl + ";", fulldecl: `${decl}\n{\n${scopestrs}\n\n${blockstrs.join("\n\n")}\n}\n` };
        }
        else {
            assert(idecl instanceof MIRInvokePrimitiveDecl);

            const params = idecl.params.map((arg) => this.varNameToCppName(arg.name));
            return { fwddecl: decl + ";", fulldecl: `${decl} { ${this.generateBuiltinBody(idecl as MIRInvokePrimitiveDecl, params)} }\n` };
        }
    }

    getEnclosingListTypeForListOp(idecl: MIRInvokePrimitiveDecl): MIRType {
        return this.typegen.getMIRType(idecl.enclosingDecl as string);
    }

    getListContentsInfoForListOp(idecl: MIRInvokePrimitiveDecl): MIRType {
        return (this.typegen.assembly.entityDecls.get(idecl.enclosingDecl as string) as MIREntityTypeDecl).terms.get("T") as MIRType;
    }

    getListResultTypeFor(idecl: MIRInvokePrimitiveDecl): [string, string, string, string] {
        const le = this.typegen.assembly.entityDecls.get(idecl.resultType as string) as MIREntityTypeDecl;
        const ltype = this.typegen.getMIRType(le.tkey);
        const ctype = le.terms.get("T") as MIRType;
        const uinc = this.typegen.getFunctorsForType(ctype).inc;
        return [this.typegen.getCPPReprFor(ltype).base, this.typegen.getCPPReprFor(ctype).std, `MIRNominalTypeEnum::${this.typegen.mangleStringForCpp(le.tkey)}`, uinc];
    }

    getSetContentsInfoForSetOp(idecl: MIRInvokePrimitiveDecl): MIRType {
        return (this.typegen.assembly.entityDecls.get(idecl.enclosingDecl as string) as MIREntityTypeDecl).terms.get("T") as MIRType;
    }

    getMapKeyContentsInfoForMapType(decl: MIRResolvedTypeKey): MIRType {
        return (this.typegen.assembly.entityDecls.get(decl) as MIREntityTypeDecl).terms.get("K") as MIRType;
    }

    getMapValueContentsInfoForMapType(decl: MIRResolvedTypeKey): MIRType {
        return (this.typegen.assembly.entityDecls.get(decl) as MIREntityTypeDecl).terms.get("V") as MIRType;
    }

    getMEntryTypeForMapType(decl: MIRResolvedTypeKey): string {
        const ktd = this.typegen.getCPPReprFor(this.getMapKeyContentsInfoForMapType(decl)).std;
        const vtd = this.typegen.getCPPReprFor(this.getMapValueContentsInfoForMapType(decl)).std;

        return `MEntry<${ktd}, ${vtd}>`;
    }

    getMEntryCmpTypeForMapType(decl: MIRResolvedTypeKey): string {
        const ktd = this.typegen.getCPPReprFor(this.getMapKeyContentsInfoForMapType(decl)).std;
        const kcmp = this.typegen.getFunctorsForType(this.getMapKeyContentsInfoForMapType(decl)).less;
        const vtd = this.typegen.getCPPReprFor(this.getMapValueContentsInfoForMapType(decl)).std;

        return `MEntryCMP<${ktd}, ${vtd}, ${kcmp}>`;
    }

    getEnclosingMapTypeForMapOp(idecl: MIRInvokePrimitiveDecl): MIRType {
        return this.typegen.getMIRType(idecl.enclosingDecl as string);
    }

    getMapKeyContentsInfoForMapOp(idecl: MIRInvokePrimitiveDecl): MIRType {
        return this.getMapKeyContentsInfoForMapType(idecl.enclosingDecl as string);
    }

    getMapValueContentsInfoForMapOp(idecl: MIRInvokePrimitiveDecl): MIRType {
        return this.getMapValueContentsInfoForMapType(idecl.enclosingDecl as string);
    }

    getMEntryTypeForMapOp(idecl: MIRInvokePrimitiveDecl): string {
        return this.getMEntryTypeForMapType(idecl.enclosingDecl as string);
    }

    getMEntryCmpTypeForMapOp(idecl: MIRInvokePrimitiveDecl): string {
        return this.getMEntryCmpTypeForMapType(idecl.enclosingDecl as string);
    }

    createListOpsFor(ltype: MIRType, ctype: MIRType): string {
        const lrepr = this.typegen.getCPPReprFor(ltype).base;
        const crepr = this.typegen.getCPPReprFor(ctype);
        const cops = this.typegen.getFunctorsForType(ctype);
        return `BSQListOps<${lrepr}, ${crepr.std}, ${cops.inc}, ${cops.dec}, ${cops.display}>`;
    }

    createMapOpsFor(mtype: MIRType, ktype: MIRType, vtype: MIRType): string {
        const mrepr = this.typegen.getCPPReprFor(mtype).base;
        const krepr = this.typegen.getCPPReprFor(ktype);
        const kops = this.typegen.getFunctorsForType(ktype);
        const vrepr = this.typegen.getCPPReprFor(vtype);
        const vops = this.typegen.getFunctorsForType(vtype);

        return `BSQMapOps<${mrepr}, ${krepr.std}, ${kops.dec}, ${kops.display}, ${kops.less}, ${kops.eq}, ${vrepr.std}, ${vops.dec}, ${vops.display}>`;
    }

    createLambdaFor(pc: MIRPCode, scopevar?: string): string {
        const pci = this.assembly.invokeDecls.get(pc.code) || this.assembly.primitiveInvokeDecls.get(pc.code) as MIRInvokeDecl;
        let params: string[] = [];
        let args: string[] = [];
        for(let i = 0; i < pci.params.length - pc.cargs.length; ++i) {
            const prepr = this.typegen.getCPPReprFor(this.typegen.getMIRType(pci.params[i].type));
            params.push(`${prepr.std} $arg_${i}`);
            args.push(`$arg_${i}`);
        }
        const cargs = pc.cargs.map((ca) => this.typegen.mangleStringForCpp(ca));
        const rrepr = this.typegen.getCPPReprFor(this.typegen.getMIRType(pci.resultType));

        if(scopevar === undefined || this.typegen.getRefCountableStatus(this.typegen.getMIRType(pci.resultType)) === "no") {
            return `[=](${params.join(", ")}) -> ${rrepr.std} { return ${this.typegen.mangleStringForCpp(pc.code)}(${[...args, ...cargs].join(", ")}); }`;
        }
        else {
            return `[=, &${scopevar}](${params.join(", ")}) -> ${rrepr.std} { return ${this.typegen.mangleStringForCpp(pc.code)}(${[...args, ...cargs, scopevar].join(", ")}); }`;
        }
    }

    generateBuiltinBody(idecl: MIRInvokePrimitiveDecl, params: string[]): string {
        const scopevar = this.varNameToCppName("$scope$");

        let bodystr = ";";
        switch (idecl.implkey) {
            case "validator_accepts": {
                const rs = this.assembly.literalRegexs.get(this.assembly.validatorRegexs.get(idecl.enclosingDecl as MIRNominalTypeKey) as string) as MIRRegex;
                bodystr = compileRegexCppMatch(rs, params[0], "$$return");
                break;
            }
            case "enum_create": {
                bodystr = `auto $$return = BSQEnum{ (uint32_t)${params[0]}, MIRNominalTypeEnum::${this.typegen.mangleStringForCpp(this.currentRType.trkey)} };`;
                break;
            }
            case "int_tofloat": {
                bodystr = `auto $$return = (double)${params[0]};`;
                break;
            }
            case "int_mod": {
                bodystr = `auto $$return = ${params[0]} % ${params[1]};`;
                break;
            }
            case "float_min_value": {
                bodystr = `auto $$return = std::numeric_limits<double>::lowest();`;
                break;
            }
            case "float_max_value": {
                bodystr = `auto $$return = std::numeric_limits<double>::max();`;
                break;
            }
            case "float_infinity_value": {
                bodystr = `auto $$return = std::numeric_limits<double>::infinty();`;
                break;
            }
            case "float_nan_value": {
                bodystr = `auto $$return = std::numeric_limits<double>::quiet_NaN();`;
                break;
            }
            case "float64_tryparse": {
                bodystr = `auto $$return = ;`;
                break;
            }
            case "float64_tostring": {
                bodystr = `auto $$return = ;`;
                break;
            }
            case "float64_parse": {
                bodystr = `auto $$return = (double)std::stod(${params[0]}->sdata);`;
                break;
            }
            case "float_toint": {
                bodystr = `BSQ_ASSERT(MIN_BSQ_INT <= ${params[0]} && ${params[0]} <= MAX_BSQ_INT, "Float64 is out of Int range"); auto $$return = (int64_t)${params[0]};`
                break;
            }
            case "float64_isinfinity": {
                bodystr = `auto $$return = isinf(${params[0]});`;
                break;
            }
            case "float64_isnan": {
                bodystr = `auto $$return = isnan(${params[0]});`;
                break;
            }
            case "float64_compare": {
                const twc = `isless(${params[0]}, ${params[1]}) ? -1 : isless(${params[1]}, ${params[0]}) ? 1 : 0`
                bodystr = `BSQ_ASSERT(!isunordered(${params[0]}, ${params[1]}), "Cannot compare nan values"); auto $$return = ${twc};`;
                break;
            }
            case "float64_abs": {
                bodystr = `auto $$return = std::abs(${params[0]});`;
                break;
            }
            case "float64_ceiling": {
                bodystr = `auto $$return = ceil(${params[0]});`;
                break;
            }
            case "float64_floor": {
                bodystr = `auto $$return = floor(${params[0]});`;
                break;
            }
            case "float64_pow": {
                bodystr = `auto $$return = pow(${params[0]}, ${params[1]});`;
                break;
            }
            case "float64_pow2": {
                bodystr = `auto $$return = exp2(${params[0]});`;
                break;
            }
            case "float64_pow10": {
                bodystr = `auto $$return = pow(10.0, ${params[0]});`;
                break;
            }
            case "float64_exp": {
                bodystr = `auto $$return = exp(${params[0]});`;
                break;
            }
            case "float64_root": {
                bodystr = `auto $$return = ;`;
                break;
            }
            case "float64_square": {
                bodystr = `auto $$return = ${params[0]} * ${params[0]};`;
                break;
            }
            case "float64_sqrt": {
                bodystr = `auto $$return = sqrt(${params[0]});`;
                break;
            }
            case "float64_log": {
                bodystr = `auto $$return = log(${params[0]});`;
                break;
            }
            case "float64_log2": {
                bodystr = `auto $$return = log2(${params[0]});`;
                break;
            }
            case "float64_log10": {
                bodystr = `auto $$return = log10(${params[0]});`;
                break;
            }
            case "float64_sin": {
                bodystr = `auto $$return = sin(${params[0]});`;
                break;
            }
            case "float64_cos": {
                bodystr = `auto $$return = cos(${params[0]});`;
                break;
            }
            case "float64_tan": {
                bodystr = `auto $$return = tan(${params[0]});`;
                break;
            }
            case "float64_min": {
                bodystr = `auto $$return = fmin(${params[0]}, ${params[1]});`;
                break;
            }
            case "float64_max": {
                bodystr = `auto $$return = fmax(${params[0]}, ${params[1]});`;
                break;
            }
            case "float64_sum": {
                bodystr = `auto $$return = std::reduce(${params[0]}->entries.begin(), ${params[0]}->entries.end(), 0.0);`;
                break;
            }
            case "float64_product": {
                bodystr = `auto $$return = std::reduce(${params[0]}->entries.begin(), ${params[0]}->entries.end(), 1.0, [](double a, double b) { return a * b; });`;
                break;
            }
            case "idkey_from_simple": {
                const kv = this.typegen.coerce(params[0], this.typegen.getMIRType(idecl.params[0].type), this.typegen.keyType);
                bodystr = `auto $$return = BSQIdKeySimple{ ${kv}, MIRNominalTypeEnum::${this.typegen.mangleStringForCpp(this.currentRType.trkey)} };`;
                break;
            }
            case "idkey_from_composite": {
                const kvs = params.map((p, i) => this.typegen.coerce(p, this.typegen.getMIRType(idecl.params[i].type), this.typegen.keyType));
                bodystr = `auto $$return = BSQIdKeyCompound{ { ${kvs.join(", ")} }, MIRNominalTypeEnum::${this.typegen.mangleStringForCpp(this.currentRType.trkey)} };`;
                break;
            }
            case "string_count": {
                bodystr = `auto $$return = ${params[0]}->sdata.size();`;
                break;
            }
            case "string_charat": {
                bodystr = `auto $$return = BSQ_NEW_NO_RC(BSQString, ${params[0]}->sdata[${params[1]}]);`;
                break;
            }
            case "string_readline": {
                const sstr = `std::string str; std::getline(std::cin, str)`;
                bodystr = `${sstr}; auto $$return = BSQ_NEW_NO_RC(BSQString, std::move(str));`;
                break;
            }
            case "string_writeline": {
                const sstr = `std::string str = std::string(${params[0]}->sdata.cbegin(), ${params[0]}->sdata.cend()); std::cout << str << "\\n"`;
                bodystr = `${sstr}; auto $$return = BSQ_NEW_NO_RC(BSQString, std::move(str));`;
                break;
            }
            case "string_concat": {
                const body = `acc.append((*iter)->sdata);`;
                const sstr = `std::string acc; for(auto iter = ${params[0]}->entries.cbegin(); iter != ${params[0]}->entries.cend(); ++iter) { ${body} }`;
                bodystr = `${sstr}; auto $$return = BSQ_NEW_NO_RC(BSQString, std::move(acc));`
                break;
            }
            case "string_substring": {
                bodystr = `auto $$return = BSQ_NEW_NO_RC(BSQString, ${params[0]}->substr(${params[1]}, ${params[2]} - ${params[1]});`;
                break;
            }
            case "safestring_string": {
                bodystr = `auto $$return =  BSQ_NEW_NO_RC(BSQString, BSQ_GET_VALUE_PTR(${params[0]}, BSQSafeString)->sdata);`;
                break;
            }
            case "safestring_unsafe_from": {
                bodystr = `auto $$return = BSQ_NEW_NO_RC(BSQSafeString, ${params[0]}->sdata, MIRNominalTypeEnum::${this.typegen.mangleStringForCpp(this.currentRType.trkey)});`;
                break;
            }
            case "stringof_string": {
                bodystr = `auto $$return = BSQ_NEW_NO_RC(BSQString, BSQ_GET_VALUE_PTR(${params[0]}, BSQStringOf)->sdata);`;
                break;
            }
            case "stringof_unsafe_from": {
                bodystr = `auto $$return = BSQ_NEW_NO_RC(BSQStringOf, ${params[0]}->sdata, MIRNominalTypeEnum::${this.typegen.mangleStringForCpp(this.currentRType.trkey)});`;
                break;
            }
            case "list_zip": {
                const ltype1 = this.typegen.getMIRType(idecl.params[0].type);
                const l1contents = (this.typegen.assembly.entityDecls.get(ltype1.trkey) as MIREntityTypeDecl).terms.get("T") as MIRType;
                const ltype1repr = this.typegen.getCPPReprFor(ltype1);

                const ltype2 = this.typegen.getMIRType(idecl.params[1].type);
                const l2contents = (this.typegen.assembly.entityDecls.get(ltype2.trkey) as MIREntityTypeDecl).terms.get("T") as MIRType;
                const ltype2repr = this.typegen.getCPPReprFor(ltype2);

                const rtype = this.typegen.getMIRType(idecl.resultType);
                const rcontents = (this.typegen.assembly.entityDecls.get(rtype.trkey) as MIREntityTypeDecl).terms.get("T") as MIRType;
                const rtyperepr = this.typegen.getCPPReprFor(rtype);

                //TODO: it would be nice if we had specialized versions of these that didn't dump into our scope manager
                const iflag = this.typegen.generateInitialDataKindFlag(rcontents);
                const codecc1 = this.typegen.coerce("uu", l1contents, this.typegen.anyType);
                const codecc2 = this.typegen.coerce("vv", l2contents, this.typegen.anyType);
                const zlambda = `[&${scopevar}](${this.typegen.getCPPReprFor(l1contents).std} uu, ${this.typegen.getCPPReprFor(l2contents).std} vv) -> ${this.typegen.getCPPReprFor(rcontents).std} { return BSQTuple::createFromSingle<${iflag}>({ INC_REF_CHECK(Value, ${codecc1}), INC_REF_CHECK(Value, ${codecc2}) }); }`;

                bodystr = `auto $$return = BSQListUtilOps::list_zip<${ltype1repr.base}, ${ltype2repr.base}, ${rtyperepr.base}, ${this.typegen.getCPPReprFor(rcontents).std}, MIRNominalTypeEnum::${this.typegen.mangleStringForCpp(rtype.trkey)}>(${params[0]}, ${params[1]}, ${zlambda});`;
                break;
            }
            case "list_unzip": {
                const rtype = this.typegen.getMIRType(idecl.resultType);
                const [rt1, rt2] = (rtype.options[0] as MIREphemeralListType).entries;
                const rtyperepr = this.typegen.getCPPReprFor(rtype);

                const repr1 = this.typegen.getCPPReprFor(rt1);
                const contents1 = (this.typegen.assembly.entityDecls.get(rt1.trkey) as MIREntityTypeDecl).terms.get("T") as MIRType;
                const contents1repr = this.typegen.getCPPReprFor(contents1);
                const repr2 = this.typegen.getCPPReprFor(rt2);
                const contents2 = (this.typegen.assembly.entityDecls.get(rt2.trkey) as MIREntityTypeDecl).terms.get("T") as MIRType;
                const contents2repr = this.typegen.getCPPReprFor(contents2);

                const ltype = this.typegen.getMIRType(idecl.params[0].type);
                const ltyperepr = this.typegen.getCPPReprFor(ltype);
                const lcontents = (this.typegen.assembly.entityDecls.get(ltype.trkey) as MIREntityTypeDecl).terms.get("T") as MIRType;
                const lcontentsrepr = this.typegen.getCPPReprFor(lcontents);

                //TODO: it would be nice if we had specialized versions of these that didn't dump into our scope manager
                const acc1 = this.typegen.coerce("cr.atFixed<0>()", this.typegen.anyType, contents1);
                const acc2 = this.typegen.coerce("cr.atFixed<1>()", this.typegen.anyType, contents2);

                const uzlambda = `[](${lcontentsrepr.std} cr) -> std::pair<${contents1repr.std}, ${contents2repr.std}> { return std::make_pair(${acc1}, ${acc2}); }`;
                const rv = `auto $uvpair$ = BSQListUtilOps::list_unzip<${repr1.base}, ${contents1repr.std}, MIRNominalTypeEnum::${this.typegen.mangleStringForCpp(rt1.trkey)}, ${repr2.base}, ${contents2repr.std}, MIRNominalTypeEnum::${this.typegen.mangleStringForCpp(rt2.trkey)}, ${ltyperepr.base}>(${params[0]}, ${uzlambda});`;

                bodystr = `${rv} auto $$return = ${rtyperepr.base}{$uvpair$.first, $uvpair$.second};`;
                break;
            }
            case "list_range": {
                const rtype = this.typegen.getMIRType(idecl.resultType);
                const rtyperepr = this.typegen.getCPPReprFor(rtype);

                bodystr = `auto $$return = BSQListUtilOps::list_range<${rtyperepr.base}, MIRNominalTypeEnum::${this.typegen.mangleStringForCpp(rtype.trkey)}>(${params[0]}, ${params[1]});`;
                break;
            }
            case "list_size": {
                bodystr = `auto $$return = (int64_t)(${params[0]}->entries.size());`;
                break;
            }
            case "list_unsafe_get": {
                bodystr = `auto $$return = ${params[0]}->entries[${params[1]}];`;
                break;
            }
            case "list_concat": {
                const ltype = this.getEnclosingListTypeForListOp(idecl);
                const ctype = this.getListContentsInfoForListOp(idecl);

                const larg = this.typegen.getMIRType(idecl.params[0].type);
                const lrepr = this.typegen.getCPPReprFor(larg).std

                bodystr = `auto $$return = ${this.createListOpsFor(ltype, ctype)}::list_concat<${lrepr}, MIRNominalTypeEnum::${this.typegen.mangleStringForCpp(ltype.trkey)}>(${params[0]});`
                break;
            }
            case "list_fill": {
                const ltype = this.getEnclosingListTypeForListOp(idecl);
                const ctype = this.getListContentsInfoForListOp(idecl);

                bodystr = `auto $$return = ${this.createListOpsFor(ltype, ctype)}::list_fill<MIRNominalTypeEnum::${this.typegen.mangleStringForCpp(ltype.trkey)}>(${params[0]}, ${params[1]});`
                break;
            }
            case "list_toset": {
                const settype = this.typegen.getMIRType(idecl.resultType);
                const setrepr = this.typegen.getCPPReprFor(settype);
                const ctype = this.getListContentsInfoForListOp(idecl);
                const crepr = this.typegen.getCPPReprFor(ctype);
                const cfuncs = this.typegen.getFunctorsForType(ctype);

                const ntype = `MIRNominalTypeEnum::${this.typegen.mangleStringForCpp(settype.trkey)}`;
                const stemplate = `BSQSet<${crepr.std}, ${cfuncs.dec}, ${cfuncs.display}, ${cfuncs.less}, ${cfuncs.eq}>`;
                bodystr = `auto $$return =  BSQ_NEW_NO_RC(${setrepr.base}, ${ntype}, ${stemplate}::processSingletonSetInit<${cfuncs.inc}>(${params[0]}->entries));`;
                break;
            }
            case "list_all": {
                const ltype = this.getEnclosingListTypeForListOp(idecl);
                const ctype = this.getListContentsInfoForListOp(idecl);
                const lambda = this.createLambdaFor(idecl.pcodes.get("p") as MIRPCode);
                bodystr = `auto $$return = ${this.createListOpsFor(ltype, ctype)}::list_all(${params[0]}, ${lambda});`
                break;
            }
            case "list_any": {
                const ltype = this.getEnclosingListTypeForListOp(idecl);
                const ctype = this.getListContentsInfoForListOp(idecl);
                const lambda = this.createLambdaFor(idecl.pcodes.get("p") as MIRPCode);
                bodystr = `auto $$return = ${this.createListOpsFor(ltype, ctype)}::list_any(${params[0]}, ${lambda});`
                break;
            }
            case "list_none": {
                const ltype = this.getEnclosingListTypeForListOp(idecl);
                const ctype = this.getListContentsInfoForListOp(idecl);
                const lambda = this.createLambdaFor(idecl.pcodes.get("p") as MIRPCode);
                bodystr = `auto $$return = ${this.createListOpsFor(ltype, ctype)}::list_none(${params[0]}, ${lambda});`
                break;
            }
            case "list_count": {
                const ltype = this.getEnclosingListTypeForListOp(idecl);
                const ctype = this.getListContentsInfoForListOp(idecl);
                const lambda = this.createLambdaFor(idecl.pcodes.get("p") as MIRPCode);
                bodystr = `auto $$return = ${this.createListOpsFor(ltype, ctype)}::list_count(${params[0]}, ${lambda});`
                break;
            }
            case "list_countnot": {
                const ltype = this.getEnclosingListTypeForListOp(idecl);
                const ctype = this.getListContentsInfoForListOp(idecl);
                const lambda = this.createLambdaFor(idecl.pcodes.get("p") as MIRPCode);
                bodystr = `auto $$return = ${this.createListOpsFor(ltype, ctype)}::list_countnot(${params[0]}, ${lambda});`
                break;
            }
            case "list_indexof": {
                const ltype = this.getEnclosingListTypeForListOp(idecl);
                const ctype = this.getListContentsInfoForListOp(idecl);
                const lambda = this.createLambdaFor(idecl.pcodes.get("p") as MIRPCode);
                bodystr = `auto $$return = ${this.createListOpsFor(ltype, ctype)}::list_indexof(${params[0]}, ${params[1]}, ${params[2]}, ${lambda});`
                break;
            }
            case "list_indexoflast": {
                const ltype = this.getEnclosingListTypeForListOp(idecl);
                const ctype = this.getListContentsInfoForListOp(idecl);
                const lambda = this.createLambdaFor(idecl.pcodes.get("p") as MIRPCode);
                bodystr = `auto $$return = ${this.createListOpsFor(ltype, ctype)}::list_indexoflast(${params[0]}, ${params[1]}, ${params[2]}, ${lambda});`
                break;
            }
            case "list_indexofnot": {
                const ltype = this.getEnclosingListTypeForListOp(idecl);
                const ctype = this.getListContentsInfoForListOp(idecl);
                const lambda = this.createLambdaFor(idecl.pcodes.get("p") as MIRPCode);
                bodystr = `auto $$return = ${this.createListOpsFor(ltype, ctype)}::list_indexofnot(${params[0]}, ${params[1]}, ${params[2]}, ${lambda});`
                break;
            }
            case "list_indexoflastnot": {
                const ltype = this.getEnclosingListTypeForListOp(idecl);
                const ctype = this.getListContentsInfoForListOp(idecl);
                const lambda = this.createLambdaFor(idecl.pcodes.get("p") as MIRPCode);
                bodystr = `auto $$return = ${this.createListOpsFor(ltype, ctype)}::list_indexoflastnot(${params[0]}, ${params[1]}, ${params[2]}, ${lambda});`
                break;
            }
            case "list_count_keytype": {
                const ltype = this.getEnclosingListTypeForListOp(idecl);
                const ctype = this.getListContentsInfoForListOp(idecl);
                const crepr = this.typegen.getCPPReprFor(ctype);
                const eqf = this.typegen.getFunctorsForType(ctype).eq;
                const lambda = `[${params[1]}](${crepr.std} a) { return ${eqf}{}(a, ${params[1]}); }`
                bodystr = `auto $$return = ${this.createListOpsFor(ltype, ctype)}::list_count(${params[0]}, ${lambda});`
                break;
            }
            case "list_indexof_keytype": {
                const ltype = this.getEnclosingListTypeForListOp(idecl);
                const ctype = this.getListContentsInfoForListOp(idecl);
                const crepr = this.typegen.getCPPReprFor(ctype);
                const eqf = this.typegen.getFunctorsForType(ctype).eq;
                const lambda = `[${params[3]}](${crepr.std} a) { return ${eqf}{}(a, ${params[3]}); }`
                bodystr = `auto $$return = ${this.createListOpsFor(ltype, ctype)}::list_indexof(${params[0]}, ${params[1]}, ${params[2]}, ${lambda});`
                break;
            }
            case "list_indexoflast_keytype": {
                const ltype = this.getEnclosingListTypeForListOp(idecl);
                const ctype = this.getListContentsInfoForListOp(idecl);
                const crepr = this.typegen.getCPPReprFor(ctype);
                const eqf = this.typegen.getFunctorsForType(ctype).eq;
                const lambda = `[${params[3]}](${crepr.std} a) { return ${eqf}{}(a, ${params[3]}); }`
                bodystr = `auto $$return = ${this.createListOpsFor(ltype, ctype)}::list_indexoflast(${params[0]}, ${params[1]}, ${params[2]}, ${lambda});`
                break;
            }
            case "list_min": {
                const ltype = this.getEnclosingListTypeForListOp(idecl);
                const ctype = this.getListContentsInfoForListOp(idecl);
                const lambda = this.typegen.getFunctorsForType(ctype).less;
                bodystr = `auto $$return = ${this.createListOpsFor(ltype, ctype)}::list_min(${params[0]}, ${lambda}{});`
                break;
            }
            case "list_max": {
                const ltype = this.getEnclosingListTypeForListOp(idecl);
                const ctype = this.getListContentsInfoForListOp(idecl);
                const lambda = this.typegen.getFunctorsForType(ctype).less;
                bodystr = `auto $$return = ${this.createListOpsFor(ltype, ctype)}::list_max(${params[0]}, ${lambda}{});`
                break;
            }
            case "list_sum": {
                const ltype = this.getEnclosingListTypeForListOp(idecl);
                const ctype = this.getListContentsInfoForListOp(idecl);
                if(ctype.trkey === "NSCore::Int") {
                    bodystr = `auto $$return = ${this.createListOpsFor(ltype, ctype)}::list_sum_int(${params[0]});`
                }
                else if(ctype.trkey === "NSCore::BigInt") {
                    bodystr = `auto $$return = ${this.createListOpsFor(ltype, ctype)}::list_sum_bigint(${params[0]});`
                }
                else {
                    bodystr = `auto $$return = ${this.createListOpsFor(ltype, ctype)}::list_sum_mixed(${params[0]});`
                }
                break;
            }
            case "list_sort": {
                const ltype = this.getEnclosingListTypeForListOp(idecl);
                const ctype = this.getListContentsInfoForListOp(idecl);
                const lambda = this.createLambdaFor(idecl.pcodes.get("cmp") as MIRPCode);
                bodystr = `auto $$return = ${this.createListOpsFor(ltype, ctype)}::list_sort(${params[0]}, ${lambda});`
                break;
            }
            case "list_filter": {
                const ltype = this.getEnclosingListTypeForListOp(idecl);
                const ctype = this.getListContentsInfoForListOp(idecl);
                const lambda = this.createLambdaFor(idecl.pcodes.get("p") as MIRPCode);
                bodystr = `auto $$return = ${this.createListOpsFor(ltype, ctype)}::list_filter(${params[0]}, ${lambda});`
                break;
            }
            case "list_filternot": {
                const ltype = this.getEnclosingListTypeForListOp(idecl);
                const ctype = this.getListContentsInfoForListOp(idecl);
                const lambda = this.createLambdaFor(idecl.pcodes.get("p") as MIRPCode);
                bodystr = `auto $$return = ${this.createListOpsFor(ltype, ctype)}::list_filternot(${params[0]}, ${lambda});`
                break;
            }
            case "list_oftype": {
                const ltype = this.getEnclosingListTypeForListOp(idecl);
                const ctype = this.getListContentsInfoForListOp(idecl);
                const rltype = this.typegen.getMIRType(idecl.resultType);
                const rlctype = (this.typegen.assembly.entityDecls.get(rltype.trkey) as MIREntityTypeDecl).terms.get("T") as MIRType;

                //TODO: it would be nice if we had specialized versions of these that didn't dump into our scope manager
                const codetc = this.generateTypeCheck("v", ctype, ctype, rlctype);
                const lambdatc = `[&${scopevar}](${this.typegen.getCPPReprFor(ctype).std} v) -> bool { return ${codetc}; }`;
                if(codetc === "false") {
                    bodystr = `auto $$return = BSQ_NEW_ADD_SCOPE(${scopevar}, ${rltype}, MIRNominalTypeEnum::${this.typegen.mangleStringForCpp(rltype.trkey)})`;
                }
                else {
                    const codecc = this.typegen.coerce("v", ctype, rlctype);
                    const rlcinc = this.typegen.getFunctorsForType(rlctype).inc;
                    const lambdacc = `[&${scopevar}](${this.typegen.getCPPReprFor(ctype).std} v) -> ${this.typegen.getCPPReprFor(rlctype).std} { return ${rlcinc}{}(${codecc}); }`;

                    bodystr = `auto $$return = ${this.createListOpsFor(ltype, ctype)}::list_oftype<${this.typegen.getCPPReprFor(rltype).base}, ${this.typegen.getCPPReprFor(rlctype).std}, MIRNominalTypeEnum::${this.typegen.mangleStringForCpp(rltype.trkey)}>(${params[0]}, ${lambdatc}, ${lambdacc});`;
                }
                break;
            }
            case "list_cast": {
                const ltype = this.getEnclosingListTypeForListOp(idecl);
                const ctype = this.getListContentsInfoForListOp(idecl);
                const rltype = this.typegen.getMIRType(idecl.resultType);
                const rlctype = (this.typegen.assembly.entityDecls.get(rltype.trkey) as MIREntityTypeDecl).terms.get("T") as MIRType;

                //TODO: we should be a bit clever here on the type conversions and only do the coerce/copy when we actually need to

                //TODO: it would be nice if we had specialized versions of these that didn't dump into our scope manager
                const codetc = this.generateTypeCheck("v", ctype, ctype, rlctype);
                const lambdatc = `[&${scopevar}](${this.typegen.getCPPReprFor(ctype).std} v) -> bool { return ${codetc}; }`;
                if(codetc === "false") {
                    const abrt = `BSQ_ABORT("Invalic element to cast", "${filenameClean(this.currentFile)}", ${idecl.sourceLocation.line});`;
                    const iec = `if(${params[0]}->entries.size() != 0) { ${abrt} }`;
                    bodystr = `${iec} auto $$return = BSQ_NEW_ADD_SCOPE(${scopevar}, ${rltype}, MIRNominalTypeEnum::${this.typegen.mangleStringForCpp(rltype.trkey)});`;
                }
                else {
                    const codecc = this.typegen.coerce("v", ctype, rlctype);
                    const rlcinc = this.typegen.getFunctorsForType(rlctype).inc;
                    const lambdacc = `[&${scopevar}](${this.typegen.getCPPReprFor(ctype).std} v) -> ${this.typegen.getCPPReprFor(rlctype).std} { return ${rlcinc}{}(${codecc}); }`;

                    bodystr = `auto $$return = ${this.createListOpsFor(ltype, ctype)}::list_cast<${this.typegen.getCPPReprFor(rltype).base}, ${this.typegen.getCPPReprFor(rlctype).std}, MIRNominalTypeEnum::${this.typegen.mangleStringForCpp(rltype.trkey)}>(${params[0]}, ${lambdatc}, ${lambdacc});`;
                }
                break;
            }
            case "list_slice": {
                const ltype = this.getEnclosingListTypeForListOp(idecl);
                const ctype = this.getListContentsInfoForListOp(idecl);

                bodystr = `auto $$return = ${this.createListOpsFor(ltype, ctype)}::list_slice(${params[0]}, ${params[1]}, ${params[2]});`;
                break;
            }
            case "list_takewhile": {
                const ltype = this.getEnclosingListTypeForListOp(idecl);
                const ctype = this.getListContentsInfoForListOp(idecl);
                const lambda = this.createLambdaFor(idecl.pcodes.get("p") as MIRPCode);
                bodystr = `auto $$return = ${this.createListOpsFor(ltype, ctype)}::list_takewhile(${params[0]}, ${lambda});`;
                break;
            }
            case "list_discardwhile": {
                const ltype = this.getEnclosingListTypeForListOp(idecl);
                const ctype = this.getListContentsInfoForListOp(idecl);
                const lambda = this.createLambdaFor(idecl.pcodes.get("p") as MIRPCode);
                bodystr = `auto $$return = ${this.createListOpsFor(ltype, ctype)}::list_discardwhile(${params[0]}, ${lambda});`;
                break;
            }
            case "list_takeuntil": {
                const ltype = this.getEnclosingListTypeForListOp(idecl);
                const ctype = this.getListContentsInfoForListOp(idecl);
                const lambda = this.createLambdaFor(idecl.pcodes.get("p") as MIRPCode);
                bodystr = `auto $$return = ${this.createListOpsFor(ltype, ctype)}::list_takeuntil(${params[0]}, ${lambda});`;
                break;
            }
            case "list_discarduntil": {
                const ltype = this.getEnclosingListTypeForListOp(idecl);
                const ctype = this.getListContentsInfoForListOp(idecl);
                const lambda = this.createLambdaFor(idecl.pcodes.get("p") as MIRPCode);
                bodystr = `auto $$return = ${this.createListOpsFor(ltype, ctype)}::list_discarduntil(${params[0]}, ${lambda});`;
                break;
            }
            case "list_unique": {
                const ltype = this.getEnclosingListTypeForListOp(idecl);
                const ctype = this.getListContentsInfoForListOp(idecl);
                const cmp = this.typegen.getFunctorsForType(ctype).less;
                bodystr = `auto $$return = ${this.createListOpsFor(ltype, ctype)}::list_unique<${cmp}>(${params[0]});`;
                break;
            }
            case "list_reverse": {
                const ltype = this.getEnclosingListTypeForListOp(idecl);
                const ctype = this.getListContentsInfoForListOp(idecl);
                bodystr = `auto $$return = ${this.createListOpsFor(ltype, ctype)}::list_reverse(${params[0]});`;
                break;
            }
            case "list_map": {
                const ltype = this.getEnclosingListTypeForListOp(idecl);
                const ctype = this.getListContentsInfoForListOp(idecl);
                const [utype, ucontents, utag] = this.getListResultTypeFor(idecl);

                const lambdascope = this.typegen.mangleStringForCpp("$lambda_scope$");
                const lambda = this.createLambdaFor(idecl.pcodes.get("f") as MIRPCode, lambdascope);
                bodystr = `BSQRefScope ${lambdascope}(true); auto $$return = ${this.createListOpsFor(ltype, ctype)}::list_map<${utype}, ${ucontents}, ${utag}>(${params[0]}, ${lambda});`;
                break;
            }
            case "list_mapindex": {
                const ltype = this.getEnclosingListTypeForListOp(idecl);
                const ctype = this.getListContentsInfoForListOp(idecl);
                const [utype, ucontents, utag] = this.getListResultTypeFor(idecl);

                const lambdascope = this.typegen.mangleStringForCpp("$lambda_scope$");
                const lambda = this.createLambdaFor(idecl.pcodes.get("f") as MIRPCode, lambdascope);
                bodystr = `BSQRefScope ${lambdascope}(true); auto $$return = ${this.createListOpsFor(ltype, ctype)}::list_mapindex<${utype}, ${ucontents}, ${utag}>(${params[0]}, ${lambda});`;
                break;
            }
            case "list_project": {
                const ltype = this.getEnclosingListTypeForListOp(idecl);
                const ctype = this.getListContentsInfoForListOp(idecl);
                const [utype, ucontents, utag, incu] = this.getListResultTypeFor(idecl);
                const mapt = this.typegen.getCPPReprFor(this.typegen.getMIRType(idecl.params[1].type)).base;

                bodystr = `auto $$return = ${this.createListOpsFor(ltype, ctype)}::list_project<${utype}, ${ucontents}, ${utag}, ${mapt}, ${incu}>(${params[0]}, ${params[1]});`;
                break;
            }
            case "list_tryproject": {
                const ltype = this.getEnclosingListTypeForListOp(idecl);
                const ctype = this.getListContentsInfoForListOp(idecl);
                const [utype, ucontents, utag, incu] = this.getListResultTypeFor(idecl);
                const mapt = this.typegen.getCPPReprFor(this.typegen.getMIRType(idecl.params[1].type)).base;

                const mirutype = (this.typegen.assembly.entityDecls.get(this.typegen.getMIRType(idecl.resultType).trkey) as MIREntityTypeDecl).terms.get("T") as MIRType;
                const utyperepr = this.typegen.getCPPReprFor(mirutype);

                const mirvvtype = (this.typegen.assembly.entityDecls.get(this.typegen.getMIRType(idecl.params[1].type).trkey) as MIREntityTypeDecl).terms.get("V") as MIRType;
                const vvtyperepr = this.typegen.getCPPReprFor(mirvvtype);

                //TODO: it would be nice if we had specialized versions of these that didn't dump into our scope manager
                const codecc = this.typegen.coerce("ccv", mirvvtype, mirutype);
                const lambdacc = `[&${scopevar}](${this.typegen.getCPPReprFor(ctype).std} ccv) -> ${utyperepr.std} { return ${codecc}; }`;
                const unone = this.typegen.coerce("BSQ_VALUE_NONE", this.typegen.noneType, mirutype);

                bodystr = `auto $$return = ${this.createListOpsFor(ltype, ctype)}::list_tryproject<${utype}, ${ucontents}, ${vvtyperepr.std}, ${utag}, ${mapt}, ${incu}>(${params[0]}, ${params[1]}, ${unone}, ${lambdacc});`;
                break;
            }
            case "list_defaultproject": {
                const ltype = this.getEnclosingListTypeForListOp(idecl);
                const ctype = this.getListContentsInfoForListOp(idecl);
                const [utype, ucontents, utag, incu] = this.getListResultTypeFor(idecl);
                const mapt = this.typegen.getCPPReprFor(this.typegen.getMIRType(idecl.params[1].type)).base;

                bodystr = `auto $$return = ${this.createListOpsFor(ltype, ctype)}::list_defaultproject<${utype}, ${ucontents}, ${utag}, ${mapt}, ${incu}>(${params[0]}, ${params[1]}, ${params[2]});`;
                break;
            }
            case "list_zipindex": {
                const ltype = this.getEnclosingListTypeForListOp(idecl);
                const ctype = this.getListContentsInfoForListOp(idecl);
                const [utype, ucontents, utag] = this.getListResultTypeFor(idecl);

                //TODO: it would be nice if we had specialized versions of these that didn't dump into our scope manager
                const codecc = this.typegen.coerce("u", ctype, this.typegen.anyType);
                const crepr = this.typegen.getCPPReprFor(ctype);
                const iflag = this.typegen.generateInitialDataKindFlag(ctype); //int component goes along with everything so just ignore it
                const lambda = `[&${scopevar}](int64_t i, ${crepr.std} u) -> ${ucontents} { return BSQTuple::createFromSingle<${iflag}>({ BSQ_ENCODE_VALUE_TAGGED_INT(i), INC_REF_CHECK(Value, ${codecc}) }); }`;

                bodystr = `auto $$return = ${this.createListOpsFor(ltype, ctype)}::list_zipindex<${utype}, ${ucontents}, ${utag}>(${params[0]}, ${lambda});`;
                break;
            }
            case "list_join": {
                const ltype = this.getEnclosingListTypeForListOp(idecl);
                const ctype = this.getListContentsInfoForListOp(idecl);
                const utype = this.typegen.getMIRType(idecl.params[1].type);
                const ucontents = (this.typegen.assembly.entityDecls.get(utype.trkey) as MIREntityTypeDecl).terms.get("T") as MIRType;
                const [tutype, tucontents, tutag] = this.getListResultTypeFor(idecl);

                //TODO: it would be nice if we had specialized versions of these that didn't dump into our scope manager
                const codecc = this.typegen.coerce("v", ctype, this.typegen.anyType);
                const codecu = this.typegen.coerce("u", ucontents, this.typegen.anyType);
                const crepr = this.typegen.getCPPReprFor(ctype);
                const urepr = this.typegen.getCPPReprFor(ucontents);
                const iflag = `${this.typegen.generateInitialDataKindFlag(ctype)} & ${this.typegen.generateInitialDataKindFlag(ucontents)}`;
                const lambda = `[&${scopevar}](${crepr.std} v, ${urepr.std} u) -> ${tucontents} { return BSQTuple::createFromSingle<${iflag}>({ INC_REF_CHECK(Value, ${codecc}), INC_REF_CHECK(Value, ${codecu}) }); }`;

                const lambdap = this.createLambdaFor(idecl.pcodes.get("p") as MIRPCode);

                bodystr = `auto $$return = ${this.createListOpsFor(ltype, ctype)}::list_join<${tutype}, ${tucontents}, ${this.typegen.getCPPReprFor(utype).base}, ${urepr.std}, ${tutag}>(${params[0]}, ${params[1]}, ${lambda}, ${lambdap});`;
                break;
            }
            case "list_joingroup": {
                const ltype = this.getEnclosingListTypeForListOp(idecl);
                const ctype = this.getListContentsInfoForListOp(idecl);
                const utype = this.typegen.getMIRType(idecl.params[1].type);
                const ucontents = (this.typegen.assembly.entityDecls.get(utype.trkey) as MIREntityTypeDecl).terms.get("T") as MIRType;
                const [tutype, tucontents, tutag] = this.getListResultTypeFor(idecl);

                //TODO: it would be nice if we had specialized versions of these that didn't dump into our scope manager
                const codecc = this.typegen.coerce("v", ctype, this.typegen.anyType);
                const codecu = this.typegen.coerce("u", utype, this.typegen.anyType);
                const crepr = this.typegen.getCPPReprFor(ctype);
                const urepr = this.typegen.getCPPReprFor(utype);
                const iflag = `${this.typegen.generateInitialDataKindFlag(ctype)} & ${this.typegen.generateInitialDataKindFlag(ucontents)}`;
                const lambda = `[&${scopevar}](${crepr.std} v, ${urepr.std} u) -> ${tucontents} { return BSQTuple::createFromSingle<${iflag}>({ INC_REF_CHECK(Value, ${codecc}), INC_REF_CHECK(Value, ${codecu}) }); }`;

                const lambdap = this.createLambdaFor(idecl.pcodes.get("p") as MIRPCode);

                bodystr = `auto $$return = ${this.createListOpsFor(ltype, ctype)}::list_joingroup<${tutype}, ${tucontents}, ${this.typegen.getCPPReprFor(utype).base}, ${this.typegen.getCPPReprFor(ucontents).std}, MIRNominalTypeEnum::${this.typegen.mangleStringForCpp(utype.trkey)}, ${tutag}, ${this.typegen.getFunctorsForType(ucontents).inc}>(${params[0]}, ${params[1]}, ${lambda}, ${lambdap});`;
                break;
            }

            case "list_append": {
                const ltype = this.getEnclosingListTypeForListOp(idecl);
                const ctype = this.getListContentsInfoForListOp(idecl);

                bodystr = `auto $$return = ${this.createListOpsFor(ltype, ctype)}::list_append(${params[0]}, ${params[1]});`;
                break;
            }
            case "list_partition": {
                const ltype = this.getEnclosingListTypeForListOp(idecl);
                const ctype = this.getListContentsInfoForListOp(idecl);

                const maptype = this.typegen.getMIRType(idecl.resultType);
                const mapentrytype = this.getMEntryTypeForMapType(maptype.trkey);
                const ktype = this.getMapKeyContentsInfoForMapType(maptype.trkey);
                const krepr = this.typegen.getCPPReprFor(ktype);
                const kops = this.typegen.getFunctorsForType(ktype);

                const lambdascope = this.typegen.mangleStringForCpp("$lambda_scope$");
                const lambdapf = this.createLambdaFor(idecl.pcodes.get("pf") as MIRPCode, lambdascope);
                const lambdamec = `[](${this.typegen.getCPPReprFor(ktype).std} kk, ${this.typegen.getCPPReprFor(ltype).std} ll) -> ${mapentrytype} { return ${mapentrytype}{kk, ll}; }`;

                bodystr = `BSQRefScope ${lambdascope}(true); auto $$return = ${this.createListOpsFor(ltype, ctype)}::list_partition<${this.typegen.getCPPReprFor(maptype).base}, MIRNominalTypeEnum::${this.typegen.mangleStringForCpp(maptype.trkey)}, ${mapentrytype}, ${krepr.std}, ${kops.dec}, ${kops.less}>(${params[0]}, ${lambdapf}, ${lambdamec});`
                break;
            }
            case "list_toindexmap": {
                const ltype = this.getEnclosingListTypeForListOp(idecl);
                const ctype = this.getListContentsInfoForListOp(idecl);

                const maptype = this.typegen.getMIRType(idecl.resultType);
                const maptyperepr = this.typegen.getCPPReprFor(maptype);
                const mapentrytype = this.getMEntryTypeForMapType(maptype.trkey);

                const lambdamec = `[](int64_t kk, ${this.typegen.getCPPReprFor(ctype).std} vv) -> ${mapentrytype} { return ${mapentrytype}{kk, ${this.typegen.getFunctorsForType(ctype).inc}{}(vv)}; }`;

                bodystr = `auto $$return = ${this.createListOpsFor(ltype, ctype)}::list_toindexmap<${maptyperepr.base}, ${mapentrytype}, MIRNominalTypeEnum::${this.typegen.mangleStringForCpp(maptype.trkey)}>(${params[0]}, ${lambdamec});`;
                break;
            }
            case "list_transformindexmap": {
                const ltype = this.getEnclosingListTypeForListOp(idecl);
                const ctype = this.getListContentsInfoForListOp(idecl);

                const maptype = this.typegen.getMIRType(idecl.resultType);
                const vftype = this.getMapValueContentsInfoForMapType(idecl.resultType)
                const maptyperepr = this.typegen.getCPPReprFor(maptype);
                const mapentrytype = this.getMEntryTypeForMapType(maptype.trkey);

                const lambdascope = this.typegen.mangleStringForCpp("$lambda_scope$");
                const lambdavf = this.createLambdaFor(idecl.pcodes.get("vf") as MIRPCode, lambdascope);
                const lambdamec = `[](int64_t kk, ${this.typegen.getCPPReprFor(vftype).std} vv) -> ${mapentrytype} { return ${mapentrytype}{kk, vv}; }`;

                bodystr = `auto $$return = ${this.createListOpsFor(ltype, ctype)}::list_transformindexmap<${maptyperepr.base}, ${mapentrytype}, MIRNominalTypeEnum::${this.typegen.mangleStringForCpp(maptype.trkey)}>(${params[0]}, ${lambdavf}, ${lambdamec});`;
                break;
            }
            case "list_transformmap": {
                const ltype = this.getEnclosingListTypeForListOp(idecl);
                const ctype = this.getListContentsInfoForListOp(idecl);

                const maptype = this.typegen.getMIRType(idecl.resultType);
                const kftype = this.getMapKeyContentsInfoForMapType(idecl.resultType)
                const vftype = this.getMapValueContentsInfoForMapType(idecl.resultType)
                const maptyperepr = this.typegen.getCPPReprFor(maptype);
                const mapentrytype = this.getMEntryTypeForMapType(maptype.trkey);

                const lambdascope = this.typegen.mangleStringForCpp("$lambda_scope$");
                const lambdakf = this.createLambdaFor(idecl.pcodes.get("kf") as MIRPCode, lambdascope);
                const lambdavf = this.createLambdaFor(idecl.pcodes.get("vf") as MIRPCode, lambdascope);
                const lambdamec = `[](${this.typegen.getCPPReprFor(kftype).std} kk, ${this.typegen.getCPPReprFor(vftype).std} vv) -> ${mapentrytype} { return ${mapentrytype}{kk, vv}; }`;

                bodystr = `auto $$return = ${this.createListOpsFor(ltype, ctype)}::list_transformmap<${maptyperepr.base}, ${mapentrytype}, MIRNominalTypeEnum::${this.typegen.mangleStringForCpp(maptype.trkey)}, ${this.typegen.getCPPReprFor(kftype).std}, ${this.typegen.getFunctorsForType(kftype).less}, ${this.typegen.getCPPReprFor(vftype).std}>(${params[0]}, ${lambdakf}, ${lambdavf}, ${lambdamec});`;
                break;
            }
            case "set_size": {
                bodystr = `auto $$return = ${params[0]}->entries.size();`;
                break;
            }
            case "set_has_key": {
                const tcmp = this.typegen.getFunctorsForType(this.getSetContentsInfoForSetOp(idecl)).less;
                bodystr = `auto $$return = std::binary_search(${params[0]}->entries.begin(), ${params[0]}->entries.end(), ${params[1]}, ${tcmp}{});`;
                break;
            }
            case "map_size": {
                bodystr = `auto $$return = ${params[0]}->entries.size();`;
                break;
            }
            case "map_has_key": {
                bodystr = `auto $$return = ${params[0]}->hasKey(${params[1]});`;
                break;
            }
            case "map_at_val": {
                bodystr = `auto $$return = ${params[0]}->getValue(${params[1]});`;
                break;
            }
            case "map_key_list": {
                const mtype = this.getEnclosingMapTypeForMapOp(idecl);
                const ktype = this.getMapKeyContentsInfoForMapOp(idecl);
                const vtype = this.getMapValueContentsInfoForMapOp(idecl);
                const ltype = this.typegen.getMIRType(idecl.resultType);
                const ltyperepr = this.typegen.getCPPReprFor(ltype).base;

                bodystr = `auto $$return = ${this.createMapOpsFor(mtype, ktype, vtype)}::map_key_list<${ltyperepr}, ${this.typegen.getFunctorsForType(ktype).inc}, MIRNominalTypeEnum::${this.typegen.mangleStringForCpp(ltype.trkey)}>(${params[0]});`;
                break;
            }
            case "map_key_set": {
                const mtype = this.getEnclosingMapTypeForMapOp(idecl);
                const ktype = this.getMapKeyContentsInfoForMapOp(idecl);
                const vtype = this.getMapValueContentsInfoForMapOp(idecl);
                const stype = this.typegen.getMIRType(idecl.resultType);
                const styperepr = this.typegen.getCPPReprFor(stype).base;

                bodystr = `auto $$return = ${this.createMapOpsFor(mtype, ktype, vtype)}::map_key_set<${styperepr}, ${this.typegen.getFunctorsForType(ktype).inc}, MIRNominalTypeEnum::${this.typegen.mangleStringForCpp(stype.trkey)}>(${params[0]});`;
                break;
            }
            case "map_values": {
                const mtype = this.getEnclosingMapTypeForMapOp(idecl);
                const ktype = this.getMapKeyContentsInfoForMapOp(idecl);
                const vtype = this.getMapValueContentsInfoForMapOp(idecl);
                const ltype = this.typegen.getMIRType(idecl.resultType);
                const ltyperepr = this.typegen.getCPPReprFor(ltype).base;

                bodystr = `auto $$return = ${this.createMapOpsFor(mtype, ktype, vtype)}::map_values<${ltyperepr}, ${this.typegen.getFunctorsForType(vtype).inc}, MIRNominalTypeEnum::${this.typegen.mangleStringForCpp(ltype.trkey)}>(${params[0]});`;
                break;
            }
            case "map_entries": {
                const mtype = this.getEnclosingMapTypeForMapOp(idecl);
                const ktype = this.getMapKeyContentsInfoForMapOp(idecl);
                const vtype = this.getMapValueContentsInfoForMapOp(idecl);
                const ltype = this.typegen.getMIRType(idecl.resultType);
                const ltyperepr = this.typegen.getCPPReprFor(ltype).base;

                const etype = (this.typegen.assembly.entityDecls.get(ltype.trkey) as MIREntityTypeDecl).terms.get("T") as MIRType;
                const etyperepr = this.typegen.getCPPReprFor(etype);

                const lambdamec = `[](${this.typegen.getCPPReprFor(ktype).std} kk, ${this.typegen.getCPPReprFor(vtype).std} vv) -> ${etyperepr.std} { return ${etyperepr.base}{${this.typegen.getFunctorsForType(ktype).inc}{}(kk), ${this.typegen.getFunctorsForType(vtype).inc}{}(vv)}; }`;

                bodystr = `auto $$return = ${this.createMapOpsFor(mtype, ktype, vtype)}::map_entries<${ltyperepr}, ${etyperepr.std}, MIRNominalTypeEnum::${this.typegen.mangleStringForCpp(ltype.trkey)}>(${params[0]}, ${lambdamec});`;
                break;
            }
            case "map_has_all": {
                const mtype = this.getEnclosingMapTypeForMapOp(idecl);
                const ktype = this.getMapKeyContentsInfoForMapOp(idecl);
                const vtype = this.getMapValueContentsInfoForMapOp(idecl);
                const ltype = this.typegen.getCPPReprFor(this.typegen.getMIRType(idecl.params[1].type)).base;

                bodystr = `auto $$return = ${this.createMapOpsFor(mtype, ktype, vtype)}::map_has_all<${ltype}>(${params[0]}, ${params[1]});`;
                break;
            }
            case "map_domainincludes": {
                const mtype = this.getEnclosingMapTypeForMapOp(idecl);
                const ktype = this.getMapKeyContentsInfoForMapOp(idecl);
                const vtype = this.getMapValueContentsInfoForMapOp(idecl);
                const stype = this.typegen.getCPPReprFor(this.typegen.getMIRType(idecl.params[1].type)).base;

                bodystr = `auto $$return = ${this.createMapOpsFor(mtype, ktype, vtype)}::map_domainincludes<${stype}>(${params[0]}, ${params[1]});`;
                break;
            }
            case "map_submap": {
                const mtype = this.getEnclosingMapTypeForMapOp(idecl);
                const ktype = this.getMapKeyContentsInfoForMapOp(idecl);
                const kops = this.typegen.getFunctorsForType(ktype);
                const vtype = this.getMapValueContentsInfoForMapOp(idecl);
                const vops = this.typegen.getFunctorsForType(vtype);

                const lambdap = this.createLambdaFor(idecl.pcodes.get("p") as MIRPCode);

                bodystr = `auto $$return = ${this.createMapOpsFor(mtype, ktype, vtype)}::map_submap<${kops.inc}, ${vops.inc}>(${params[0]}, ${lambdap});`;
                break;
            }

            case "map_oftype": {
                const mtype = this.getEnclosingMapTypeForMapOp(idecl);
                const ktype = this.getMapKeyContentsInfoForMapOp(idecl);
                const vtype = this.getMapValueContentsInfoForMapOp(idecl);

                const rmtype = this.typegen.getMIRType(idecl.resultType);
                const rmrepr = this.typegen.getCPPReprFor(rmtype);
                const rmentry = this.getMEntryTypeForMapType(idecl.resultType);

                //TODO: it would be nice if we had specialized versions of these that didn't dump into our scope manager
                const ttype = this.typegen.getMIRType(idecl.binds.get("T") as MIRResolvedTypeKey);
                const codetck = this.generateTypeCheck("kk", ktype, ktype, ttype);
                const lambdatck = `[&${scopevar}](${this.typegen.getCPPReprFor(ktype).std} kk) -> bool { return ${codetck}; }`;

                const utype = this.typegen.getMIRType(idecl.binds.get("U") as MIRResolvedTypeKey);
                const codetcv = this.generateTypeCheck("vv", vtype, vtype, utype);
                const lambdatcv = `[&${scopevar}](${this.typegen.getCPPReprFor(vtype).std} vv) -> bool { return ${codetcv}; }`;

                if(codetck === "false" || codetcv == "false") {
                    bodystr = `auto $$return = BSQ_NEW_ADD_SCOPE(${scopevar}, ${rmtype}, MIRNominalTypeEnum::${this.typegen.mangleStringForCpp(rmtype.trkey)})`;
                }
                else {
                    //TODO: it would be nice if we had specialized versions of these that didn't dump into our scope manager
                    const codecck = `${this.typegen.getFunctorsForType(ttype).inc}{}(${this.typegen.coerce("kk", ktype, ttype)})`;
                    const codeccv = `${this.typegen.getFunctorsForType(utype).inc}{}(${this.typegen.coerce("vv", vtype, utype)})`;
                    const lambdacc = `[&${scopevar}](${this.typegen.getCPPReprFor(ktype).std} kk, ${this.typegen.getCPPReprFor(vtype).std} vv) -> ${rmentry} { return ${rmentry}{${codecck}, ${codeccv}}; }`;

                    bodystr = `auto $$return = ${this.createMapOpsFor(mtype, ktype, vtype)}::map_oftype<${rmrepr.base}, ${rmentry}, MIRNominalTypeEnum::${this.typegen.mangleStringForCpp(rmtype.trkey)}>(${params[0]}, ${lambdatck}, ${lambdatcv}, ${lambdacc});`;
                }
                break;
            }
            case "map_cast": {
                const mtype = this.getEnclosingMapTypeForMapOp(idecl);
                const ktype = this.getMapKeyContentsInfoForMapOp(idecl);
                const vtype = this.getMapValueContentsInfoForMapOp(idecl);

                const rmtype = this.typegen.getMIRType(idecl.resultType);
                const rmrepr = this.typegen.getCPPReprFor(rmtype);
                const rmentry = this.getMEntryTypeForMapType(idecl.resultType);

                //TODO: it would be nice if we had specialized versions of these that didn't dump into our scope manager
                const ttype = this.typegen.getMIRType(idecl.binds.get("T") as MIRResolvedTypeKey);
                const codetck = this.generateTypeCheck("kk", ktype, ktype, ttype);
                const lambdatck = `[&${scopevar}](${this.typegen.getCPPReprFor(ktype).std} kk) -> bool { return ${codetck}; }`;

                const utype = this.typegen.getMIRType(idecl.binds.get("U") as MIRResolvedTypeKey);
                const codetcv = this.generateTypeCheck("vv", vtype, vtype, utype);
                const lambdatcv = `[&${scopevar}](${this.typegen.getCPPReprFor(vtype).std} vv) -> bool { return ${codetcv}; }`;

                if(codetck === "false" || codetcv == "false") {
                    bodystr = `auto $$return = BSQ_NEW_ADD_SCOPE(${scopevar}, ${rmtype}, MIRNominalTypeEnum::${this.typegen.mangleStringForCpp(rmtype.trkey)})`;
                }
                else {
                    //TODO: it would be nice if we had specialized versions of these that didn't dump into our scope manager
                    const codecck = `${this.typegen.getFunctorsForType(ttype).inc}{}(${this.typegen.coerce("kk", ktype, ttype)})`;
                    const codeccv = `${this.typegen.getFunctorsForType(utype).inc}{}(${this.typegen.coerce("vv", vtype, utype)})`;
                    const lambdacc = `[&${scopevar}](${this.typegen.getCPPReprFor(ktype).std} kk, ${this.typegen.getCPPReprFor(vtype).std} vv) -> ${rmentry} { return ${rmentry}{${codecck}, ${codeccv}}; }`;

                    bodystr = `auto $$return = ${this.createMapOpsFor(mtype, ktype, vtype)}::map_cast<${rmrepr.base}, ${rmentry}, MIRNominalTypeEnum::${this.typegen.mangleStringForCpp(rmtype.trkey)}>(${params[0]}, ${lambdatck}, ${lambdatcv}, ${lambdacc});`;
                }
                break;
            }
            case "map_projectall": {
                const mtype = this.getEnclosingMapTypeForMapOp(idecl);
                const ktype = this.getMapKeyContentsInfoForMapOp(idecl);
                const vtype = this.getMapValueContentsInfoForMapOp(idecl);
                const ltype = this.typegen.getCPPReprFor(this.typegen.getMIRType(idecl.params[1].type)).base;

                const kfuncs = this.typegen.getFunctorsForType(ktype);
                const vfuncs = this.typegen.getFunctorsForType(vtype);
                bodystr = `auto $$return = ${this.createMapOpsFor(mtype, ktype, vtype)}::map_projectall<${ltype}, ${kfuncs.inc}, ${vfuncs.inc}>(${params[0]}, ${params[1]});`;
                break;
            }
            case "map_excludeall": {
                const mtype = this.getEnclosingMapTypeForMapOp(idecl);
                const ktype = this.getMapKeyContentsInfoForMapOp(idecl);
                const vtype = this.getMapValueContentsInfoForMapOp(idecl);
                const ltype = this.typegen.getCPPReprFor(this.typegen.getMIRType(idecl.params[1].type)).base;

                const kfuncs = this.typegen.getFunctorsForType(ktype);
                const vfuncs = this.typegen.getFunctorsForType(vtype);
                bodystr = `auto $$return = ${this.createMapOpsFor(mtype, ktype, vtype)}::map_excludeall<${ltype}, ${kfuncs.inc}, ${vfuncs.inc}>(${params[0]}, ${params[1]});`;
                break;
            }
            case "map_project": {
                const mtype = this.getEnclosingMapTypeForMapOp(idecl);
                const ktype = this.getMapKeyContentsInfoForMapOp(idecl);
                const vtype = this.getMapValueContentsInfoForMapOp(idecl);
                const stype = this.typegen.getCPPReprFor(this.typegen.getMIRType(idecl.params[1].type)).base;

                const kfuncs = this.typegen.getFunctorsForType(ktype);
                const vfuncs = this.typegen.getFunctorsForType(vtype);
                bodystr = `auto $$return = ${this.createMapOpsFor(mtype, ktype, vtype)}::map_project<${stype}, ${kfuncs.inc}, ${vfuncs.inc}>(${params[0]}, ${params[1]});`;
                break;
            }
            case "map_exclude": {
                const mtype = this.getEnclosingMapTypeForMapOp(idecl);
                const ktype = this.getMapKeyContentsInfoForMapOp(idecl);
                const vtype = this.getMapValueContentsInfoForMapOp(idecl);
                const stype = this.typegen.getCPPReprFor(this.typegen.getMIRType(idecl.params[1].type)).base;

                const kfuncs = this.typegen.getFunctorsForType(ktype);
                const vfuncs = this.typegen.getFunctorsForType(vtype);
                bodystr = `auto $$return = ${this.createMapOpsFor(mtype, ktype, vtype)}::map_exclude<${stype}, ${kfuncs.inc}, ${vfuncs.inc}>(${params[0]}, ${params[1]});`;
                break;
            }
            case "map_remap": {
                const mtype = this.getEnclosingMapTypeForMapOp(idecl);
                const ktype = this.getMapKeyContentsInfoForMapOp(idecl);
                const vtype = this.getMapValueContentsInfoForMapOp(idecl);

                const rtype = this.typegen.getMIRType(idecl.resultType);
                const rtyperepr = this.typegen.getCPPReprFor(rtype);
                const utype = (this.typegen.assembly.entityDecls.get(rtype.trkey) as MIREntityTypeDecl).terms.get("V") as MIRType;
                const utyperepr = this.typegen.getCPPReprFor(utype);

                const lambdascope = this.typegen.mangleStringForCpp("$lambda_scope$");
                const lambdaf = this.createLambdaFor(idecl.pcodes.get("f") as MIRPCode, lambdascope);

                bodystr = `BSQRefScope ${lambdascope}(true); auto $$return = ${this.createMapOpsFor(mtype, ktype, vtype)}::map_remap<${rtyperepr.base}, ${utyperepr.std}, MIRNominalTypeEnum::${this.typegen.mangleStringForCpp(rtype.trkey)}, ${this.typegen.getFunctorsForType(ktype).inc}>(${params[0]}, ${lambdaf});`;
                break;
            }
            case "map_composewith": {
                const mtype = this.getEnclosingMapTypeForMapOp(idecl);
                const ktype = this.getMapKeyContentsInfoForMapOp(idecl);
                const vtype = this.getMapValueContentsInfoForMapOp(idecl);

                const rtype = this.typegen.getMIRType(idecl.resultType);
                const rtyperepr = this.typegen.getCPPReprFor(rtype);
                const utype = (this.typegen.assembly.entityDecls.get(rtype.trkey) as MIREntityTypeDecl).terms.get("V") as MIRType;
                const utyperepr = this.typegen.getCPPReprFor(utype);

                const maputype = this.typegen.getMIRType(idecl.params[1].type);
                const maputyperepr = this.typegen.getCPPReprFor(maputype);

                bodystr = `auto $$return = ${this.createMapOpsFor(mtype, ktype, vtype)}::map_compose<${rtyperepr.base}, ${utyperepr.std}, ${this.typegen.getFunctorsForType(utype).inc}, MIRNominalTypeEnum::${this.typegen.mangleStringForCpp(rtype.trkey)}, ${this.typegen.getFunctorsForType(ktype).inc}, ${maputyperepr.base}>(${params[0]}, ${params[1]});`;
                break;
            }
            case "map_trycomposewith": {
                const mtype = this.getEnclosingMapTypeForMapOp(idecl);
                const ktype = this.getMapKeyContentsInfoForMapOp(idecl);
                const vtype = this.getMapValueContentsInfoForMapOp(idecl);

                const rtype = this.typegen.getMIRType(idecl.resultType);
                const rtyperepr = this.typegen.getCPPReprFor(rtype);
                const utype = (this.typegen.assembly.entityDecls.get(idecl.params[1].type) as MIREntityTypeDecl).terms.get("V") as MIRType;
                const utyperepr = this.typegen.getCPPReprFor(utype);

                const mutype = this.getMapValueContentsInfoForMapType(idecl.resultType);
                const mutyperepr = this.typegen.getCPPReprFor(mutype);

                const maputype = this.typegen.getMIRType(idecl.params[1].type);
                const maputyperepr = this.typegen.getCPPReprFor(maputype);

                //TODO: it would be nice if we had specialized versions of these that didn't dump into our scope manager
                const codecc = this.typegen.coerce("ccu", utype, mutype);
                const lambdaconv = `[&${scopevar}](${utyperepr.std} ccu) -> ${mutyperepr.std} { return ${codecc}; }`;
                const unone = this.typegen.coerce("BSQ_VALUE_NONE", this.typegen.noneType, mutype);

                bodystr = `auto $$return = ${this.createMapOpsFor(mtype, ktype, vtype)}::map_trycompose<${rtyperepr.base}, ${utyperepr.std}, ${mutyperepr.std}, MIRNominalTypeEnum::${this.typegen.mangleStringForCpp(rtype.trkey)}, ${this.typegen.getFunctorsForType(ktype).inc}, ${maputyperepr.base}>(${params[0]}, ${params[1]}, ${unone}, ${lambdaconv});`;
                break;
            }
            case "map_defaultcomposewith": {
                const mtype = this.getEnclosingMapTypeForMapOp(idecl);
                const ktype = this.getMapKeyContentsInfoForMapOp(idecl);
                const vtype = this.getMapValueContentsInfoForMapOp(idecl);

                const rtype = this.typegen.getMIRType(idecl.resultType);
                const rtyperepr = this.typegen.getCPPReprFor(rtype);
                const utype = (this.typegen.assembly.entityDecls.get(rtype.trkey) as MIREntityTypeDecl).terms.get("V") as MIRType;
                const utyperepr = this.typegen.getCPPReprFor(utype);

                const maputype = this.typegen.getMIRType(idecl.params[1].type);
                const maputyperepr = this.typegen.getCPPReprFor(maputype);

                bodystr = `auto $$return = ${this.createMapOpsFor(mtype, ktype, vtype)}::map_defaultcompose<${rtyperepr.base}, ${utyperepr.std}, ${this.typegen.getFunctorsForType(utype).inc}, MIRNominalTypeEnum::${this.typegen.mangleStringForCpp(rtype.trkey)}, ${this.typegen.getFunctorsForType(ktype).inc}, ${maputyperepr.base}>(${params[0]}, ${params[1]}, ${params[2]});`;
                break;
            }
            case "map_invertinj": {
                const mtype = this.getEnclosingMapTypeForMapOp(idecl);
                const ktype = this.getMapKeyContentsInfoForMapOp(idecl);
                const kops = this.typegen.getFunctorsForType(ktype);
                const vtype = this.getMapValueContentsInfoForMapOp(idecl);
                const vops = this.typegen.getFunctorsForType(vtype);

                const rtype = this.typegen.getMIRType(idecl.resultType);
                const rtyperepr = this.typegen.getCPPReprFor(rtype);

                bodystr = `auto $$return = ${this.createMapOpsFor(mtype, ktype, vtype)}::map_injinvert<${rtyperepr.base}, MIRNominalTypeEnum::${this.typegen.mangleStringForCpp(rtype.trkey)}, ${kops.inc}, ${vops.inc}, ${vops.less}, ${vops.eq}>(${params[0]});`;
                break;
            }
            case "map_invertrel": {
                const mtype = this.getEnclosingMapTypeForMapOp(idecl);
                const ktype = this.getMapKeyContentsInfoForMapOp(idecl);
                const kops = this.typegen.getFunctorsForType(ktype);
                const vtype = this.getMapValueContentsInfoForMapOp(idecl);
                const vops = this.typegen.getFunctorsForType(vtype);

                const rtype = this.typegen.getMIRType(idecl.resultType);
                const rtyperepr = this.typegen.getCPPReprFor(rtype);

                const ltype = (this.typegen.assembly.entityDecls.get(rtype.trkey) as MIREntityTypeDecl).terms.get("V") as MIRType;
                const ltyperepr = this.typegen.getCPPReprFor(ltype);

                bodystr = `auto $$return = ${this.createMapOpsFor(mtype, ktype, vtype)}::map_relinvert<${ltyperepr.base}, MIRNominalTypeEnum::${this.typegen.mangleStringForCpp(ltype.trkey)}, ${rtyperepr.base}, MIRNominalTypeEnum::${this.typegen.mangleStringForCpp(rtype.trkey)}, ${kops.inc}, ${vops.inc}, ${vops.less}>(${params[0]});`;
                break;
            }
            case "map_union": {
                const mtype = this.getEnclosingMapTypeForMapOp(idecl);
                const ktype = this.getMapKeyContentsInfoForMapOp(idecl);
                const kops = this.typegen.getFunctorsForType(ktype);
                const vtype = this.getMapValueContentsInfoForMapOp(idecl);
                const vops = this.typegen.getFunctorsForType(vtype);

                bodystr = `auto $$return = ${this.createMapOpsFor(mtype, ktype, vtype)}::map_union<${kops.inc}, ${vops.inc}>(${params[0]}, ${params[1]});`;
                break;
            }
            case "map_unionall": {
                const mtype = this.getEnclosingMapTypeForMapOp(idecl);
                const ktype = this.getMapKeyContentsInfoForMapOp(idecl);
                const kops = this.typegen.getFunctorsForType(ktype);
                const vtype = this.getMapValueContentsInfoForMapOp(idecl);
                const vops = this.typegen.getFunctorsForType(vtype);

                const rtype = this.typegen.getMIRType(idecl.resultType);
                const ltyperepr = this.typegen.getCPPReprFor(this.typegen.getMIRType(idecl.params[0].type));

                bodystr = `auto $$return = ${this.createMapOpsFor(mtype, ktype, vtype)}::map_unionall<${ltyperepr.base}, MIRNominalTypeEnum::${this.typegen.mangleStringForCpp(rtype.trkey)}, ${kops.inc}, ${vops.inc}>(${params[0]});`;
                break;
            }
            case "map_merge": {
                const mtype = this.getEnclosingMapTypeForMapOp(idecl);
                const ktype = this.getMapKeyContentsInfoForMapOp(idecl);
                const kops = this.typegen.getFunctorsForType(ktype);
                const vtype = this.getMapValueContentsInfoForMapOp(idecl);
                const vops = this.typegen.getFunctorsForType(vtype);

                bodystr = `auto $$return = ${this.createMapOpsFor(mtype, ktype, vtype)}::map_merge<${kops.inc}, ${vops.inc}>(${params[0]}, ${params[1]});`;
                break;
            }
            case "map_mergeall": {
                const mtype = this.getEnclosingMapTypeForMapOp(idecl);
                const ktype = this.getMapKeyContentsInfoForMapOp(idecl);
                const kops = this.typegen.getFunctorsForType(ktype);
                const vtype = this.getMapValueContentsInfoForMapOp(idecl);
                const vops = this.typegen.getFunctorsForType(vtype);

                const rtype = this.typegen.getMIRType(idecl.resultType);
                const ltyperepr = this.typegen.getCPPReprFor(this.typegen.getMIRType(idecl.params[0].type));

                bodystr = `auto $$return = ${this.createMapOpsFor(mtype, ktype, vtype)}::map_mergeall<${ltyperepr.base}, MIRNominalTypeEnum::${this.typegen.mangleStringForCpp(rtype.trkey)}, ${kops.inc}, ${vops.inc}>(${params[0]});`;
                break;
            }
            case "iteration_while": {
                assert(false, `Need to implement -- ${idecl.iname}`);
                break;
            }
            case "iteration_until": {
                assert(false, `Need to implement -- ${idecl.iname}`);
                break;
            }
            case "iteration_steps": {
                const statetype = this.typegen.getMIRType(idecl.binds.get("S") as string);
                const staterepr = this.typegen.getCPPReprFor(statetype);
                const statefuncs = this.typegen.getFunctorsForType(statetype);

                const lambdascope = this.typegen.mangleStringForCpp("$lambda_scope$");
                const lambdastep = this.createLambdaFor(idecl.pcodes.get("step") as MIRPCode, lambdascope);

                const header = `BSQRefScope ${lambdascope}(true); ${staterepr.std} cacc = ${params[0]};`
                const ctrl = `for(int64_t i = 0; i < ${params[1]}; ++i)`;

                const rcstatus = this.typegen.getRefCountableStatus(statetype);
                const bodynorc = `{ cacc = ${lambdastep}(cacc); }`;
                const bodyrc = `{ ${staterepr.std} nacc = ${lambdastep}(cacc); ${statefuncs.dec}{}(cacc); cacc = nacc; }`;

                bodystr = `${header} ${ctrl} ${rcstatus === "no" ? bodynorc : bodyrc} auto $$return = cacc;`;
                break;
            }
            case "iteration_reduce": {
                const ttype = this.typegen.getMIRType(idecl.binds.get("T") as string);
                const trepr = this.typegen.getCPPReprFor(ttype);
                const tfuncs = this.typegen.getFunctorsForType(ttype);

                const lambdascope = this.typegen.mangleStringForCpp("$lambda_scope$");
                const lambdaop = this.createLambdaFor(idecl.pcodes.get("op") as MIRPCode, lambdascope);

                const header = `BSQRefScope ${lambdascope}(true); ${trepr.std} cacc = ${params[0]};`
                const ctrl = `for(size_t i = 0; i < ${params[1]}->entries.size(); ++i)`;

                const rcstatus = this.typegen.getRefCountableStatus(ttype);
                const bodynorc = `{ cacc = ${lambdaop}(cacc, ${params[1]}->entries[i]); }`;
                const bodyrc = `{ ${trepr.std} nacc = ${lambdaop}(cacc, ${params[1]}->entries[i]); ${tfuncs.dec}{}(cacc); cacc = nacc; }`;

                bodystr = `${header} ${ctrl} ${rcstatus === "no" ? bodynorc : bodyrc} auto $$return = cacc;`;
                break;
            }
            default: {
                assert(false, `Need to implement -- ${idecl.iname}`);
                break;
            }
        }

        const refscope = `BSQRefScope ${scopevar};`;
        let returnmgr = "";
        if (this.typegen.getRefCountableStatus(this.currentRType) !== "no") {
            returnmgr = this.typegen.buildReturnOpForType(this.currentRType, "$$return", "$callerscope$") + ";";
        }

        return "\n    " + refscope + "\n    " + bodystr + "\n    " + returnmgr + "\n    " + "return $$return;\n";
    }
}

export {
    CPPBodyEmitter
};
