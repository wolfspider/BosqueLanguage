//-------------------------------------------------------------------------------------------------------
// Copyright (C) Microsoft. All rights reserved.
// Licensed under the MIT license. See LICENSE.txt file in the project root for full license information.
//-------------------------------------------------------------------------------------------------------

import { SourceInfo, Parser } from "../ast/parser";
import { MIRTempRegister, MIROp, MIRLoadConst, MIRConstantNone, MIRConstantTrue, MIRConstantFalse, MIRConstantInt, MIRConstantString, MIRLoadConstTypedString, MIRAccessArgVariable, MIRAccessLocalVariable, MIRArgument, MIRConstructorPrimary, MIRConstructorPrimaryCollectionSingletons, MIRConstructorPrimaryCollectionCopies, MIRConstructorPrimaryCollectionMixed, MIRAccessFromIndex, MIRProjectFromIndecies, MIRProjectFromProperties, MIRProjectFromFields, MIRAccessFromProperty, MIRAccessFromField, MIRConstructorTuple, MIRConstructorRecord, MIRConstructorPrimaryCollectionEmpty, MIRResolvedTypeKey, MIRFieldKey, MIRLoadFieldDefaultValue, MIRProjectFromTypeTuple, MIRProjectFromTypeRecord, MIRProjectFromTypeNominal, MIRModifyWithIndecies, MIRModifyWithProperties, MIRModifyWithFields, MIRStructuredExtendTuple, MIRStructuredExtendRecord, MIRStructuredExtendObject, MIRVirtualMethodKey, MIRJump, MIRJumpCond, MIRPrefixOp, MIRBinOp, MIRBinCmp, MIRBinEq, MIRRegAssign, MIRVarStore, MIRReturnAssign, MIRVarLifetimeStart, MIRVarLifetimeEnd, MIRBody, MIRBasicBlock, MIRTruthyConvert, MIRJumpNone, MIRDebug, MIRVariable, MIRIsTypeOfNone, MIRIsTypeOfSome, MIRIsTypeOf, MIRAbort, MIRInvokeKey, MIRConstantKey, MIRAccessConstantValue, MIRInvokeFixedFunction, MIRInvokeVirtualFunction, MIRNominalTypeKey, MIRConstructorEphemeralValueList, MIRLoadConstSafeString, MIRInvokeInvariantCheckDirect, MIRInvokeInvariantCheckVirtualTarget, MIRLoadFromEpehmeralList, MIRRegisterArgument, MIRPackSlice, MIRPackExtend, MIRConstantBigInt, MIRConstantFloat64, MIRBinLess, MIRConstantRegex } from "./mir_ops";
import { OOPTypeDecl, StaticFunctionDecl, MemberMethodDecl, InvokeDecl, Assembly, NamespaceFunctionDecl, NamespaceConstDecl, StaticMemberDecl, ConceptTypeDecl, EntityTypeDecl, BuildLevel } from "../ast/assembly";
import { ResolvedType, ResolvedEntityAtomType, ResolvedConceptAtomType, ResolvedTupleAtomType, ResolvedRecordAtomType, ResolvedFunctionType, ResolvedConceptAtomTypeEntry, ResolvedEphemeralListType } from "../ast/resolved_type";
import { PackageConfig, MIRAssembly, MIRType, MIRTypeOption, MIREntityType, MIRConceptType, MIRTupleTypeEntry, MIRTupleType, MIRRecordTypeEntry, MIRRecordType, MIRConceptTypeDecl, MIREntityTypeDecl, MIREphemeralListType } from "./mir_assembly";

import * as Crypto from "crypto";
import { TypeChecker } from "../type_checker/type_checker";
import { propagateTmpAssignForBody, removeDeadTempAssignsFromBody } from "./mir_cleanup";
import { convertBodyToSSA } from "./mir_ssa";
import { computeVarTypesForInvoke } from "./mir_vartype";
import { functionalizeInvokes } from "./functionalize";

type PCode = {
    code: InvokeDecl,
    scope: MIRInvokeKey,
    captured: Map<string, ResolvedType>,
    ftype: ResolvedFunctionType
};

class MIRKeyGenerator {
    static computeBindsKeyInfo(binds: Map<string, ResolvedType>): string {
        if (binds.size === 0) {
            return "";
        }

        let terms: string[] = [];
        binds.forEach((v, k) => terms.push(`${k}=${v.idStr}`));

        return `<${terms.sort().join(", ")}>`;
    }

    static computePCodeKeyInfo(pcodes: PCode[]): string {
        if (pcodes.length === 0) {
            return "";
        }

        return "[" + pcodes.map((pc) => `${pc.code.srcFile}%${pc.code.sourceLocation.line}%${pc.code.sourceLocation.column}`).join(",") + "]";
    }

    static generateTypeKey(t: OOPTypeDecl, binds: Map<string, ResolvedType>): MIRResolvedTypeKey {
        return `${t.ns}::${t.name}${MIRKeyGenerator.computeBindsKeyInfo(binds)}`;
    }

    static generateGlobalKey(ns: string, name: string): MIRConstantKey {
        return `${ns}::${name}`;
    }

    static generateConstKey(t: OOPTypeDecl, binds: Map<string, ResolvedType>, name: string): MIRConstantKey {
        return `${MIRKeyGenerator.generateTypeKey(t, binds)}::${name}`;
    }

    static generateFieldKey(t: OOPTypeDecl, binds: Map<string, ResolvedType>, name: string): MIRFieldKey {
        return `${MIRKeyGenerator.generateTypeKey(t, binds)}.${name}`;
    }

    static generateFunctionKey(ns: string, name: string, binds: Map<string, ResolvedType>, pcodes: PCode[]): MIRInvokeKey {
        return `${ns}::${name}${MIRKeyGenerator.computeBindsKeyInfo(binds)}${MIRKeyGenerator.computePCodeKeyInfo(pcodes)}`;
    }

    static generateStaticKey(t: OOPTypeDecl, name: string, binds: Map<string, ResolvedType>, pcodes: PCode[]): MIRInvokeKey {
        return `${t.ns}::${t.name}::${name}${MIRKeyGenerator.computeBindsKeyInfo(binds)}${MIRKeyGenerator.computePCodeKeyInfo(pcodes)}`;
    }

    static generateMethodKey(t: OOPTypeDecl, name: string, binds: Map<string, ResolvedType>, pcodes: PCode[]): MIRInvokeKey {
        return `${t.ns}::${t.name}::${name}${MIRKeyGenerator.computeBindsKeyInfo(binds)}${MIRKeyGenerator.computePCodeKeyInfo(pcodes)}`;
    }

    static generateVirtualMethodKey(vname: string, binds: Map<string, ResolvedType>): MIRVirtualMethodKey {
        return `${vname}${MIRKeyGenerator.computeBindsKeyInfo(binds)}`;
    }

    static generatePCodeKey(inv: InvokeDecl): MIRInvokeKey {
        return `fn--${inv.srcFile}+${inv.sourceLocation.line}##${inv.sourceLocation.pos}`;
    }
}

class MIRBodyEmitter {
    private m_blockMap: Map<string, MIRBasicBlock> = new Map<string, MIRBasicBlock>();
    private m_currentBlock: MIROp[] = [];

    private m_tmpIDCtr = 0;

    initialize() {
        this.m_tmpIDCtr = 0;

        this.m_blockMap = new Map<string, MIRBasicBlock>();
        this.m_blockMap.set("entry", new MIRBasicBlock("entry", []));
        this.m_blockMap.set("returnassign", new MIRBasicBlock("returnassign", []));
        this.m_blockMap.set("exit", new MIRBasicBlock("exit", []));

        this.m_currentBlock = (this.m_blockMap.get("entry") as MIRBasicBlock).ops;
    }

    generateTmpRegister(): MIRTempRegister {
        return new MIRTempRegister(this.m_tmpIDCtr++);
    }

    generateCapturedVarName(name: string): string {
        return "__c_" + name;
    }

    createNewBlock(pfx: string): string {
        const name = `${pfx}_${this.m_blockMap.size}`;
        this.m_blockMap.set(name, new MIRBasicBlock(name, []));

        return name;
    }

    setActiveBlock(name: string) {
        this.m_currentBlock = (this.m_blockMap.get(name) as MIRBasicBlock).ops;
    }

    emitLoadConstNone(sinfo: SourceInfo, trgt: MIRTempRegister) {
        this.m_currentBlock.push(new MIRLoadConst(sinfo, new MIRConstantNone(), trgt));
    }

    emitLoadConstBool(sinfo: SourceInfo, bv: boolean, trgt: MIRTempRegister) {
        this.m_currentBlock.push(new MIRLoadConst(sinfo, bv ? new MIRConstantTrue() : new MIRConstantFalse(), trgt));
    }

    emitLoadConstInt(sinfo: SourceInfo, iv: string, trgt: MIRTempRegister) {
        this.m_currentBlock.push(new MIRLoadConst(sinfo, new MIRConstantInt(iv), trgt));
    }

    emitLoadConstBigInt(sinfo: SourceInfo, iv: string, trgt: MIRTempRegister) {
        this.m_currentBlock.push(new MIRLoadConst(sinfo, new MIRConstantBigInt(iv), trgt));
    }

    emitLoadConstFloat(sinfo: SourceInfo, fv: string, trgt: MIRTempRegister)  {
        this.m_currentBlock.push(new MIRLoadConst(sinfo, new MIRConstantFloat64(fv), trgt));
    }

    emitLoadConstString(sinfo: SourceInfo, sv: string, trgt: MIRTempRegister) {
        this.m_currentBlock.push(new MIRLoadConst(sinfo, new MIRConstantString(sv), trgt));
    }

    emitLoadLiteralRegex(sinfo: SourceInfo, restr: string, trgt: MIRTempRegister) {
        this.m_currentBlock.push(new MIRLoadConst(sinfo, new MIRConstantRegex(restr), trgt));
    }

    emitLoadValidatedTypedString(sinfo: SourceInfo, sv: string, tkey: MIRNominalTypeKey, tskey: MIRResolvedTypeKey, trgt: MIRTempRegister) {
        this.m_currentBlock.push(new MIRLoadConstSafeString(sinfo, sv, tkey, tskey, trgt));
    }

    emitLoadConstTypedString(sinfo: SourceInfo, sv: string, tkey: MIRNominalTypeKey, tskey: MIRResolvedTypeKey, pfunckey: MIRInvokeKey | undefined, errtype: MIRResolvedTypeKey | undefined, trgt: MIRTempRegister) {
        this.m_currentBlock.push(new MIRLoadConstTypedString(sinfo, sv, tkey, tskey, pfunckey, errtype, trgt));
    }

    emitAccessConstant(sinfo: SourceInfo, gkey: MIRConstantKey, trgt: MIRTempRegister) {
        this.m_currentBlock.push(new MIRAccessConstantValue(sinfo, gkey, trgt));
    }

    emitLoadMemberFieldDefaultValue(sinfo: SourceInfo, ckey: MIRFieldKey, trgt: MIRTempRegister) {
        this.m_currentBlock.push(new MIRLoadFieldDefaultValue(sinfo, ckey, trgt));
    }

    emitAccessArgVariable(sinfo: SourceInfo, name: string, trgt: MIRTempRegister) {
        this.m_currentBlock.push(new MIRAccessArgVariable(sinfo, new MIRVariable(name), trgt));
    }

    emitAccessLocalVariable(sinfo: SourceInfo, name: string, trgt: MIRTempRegister) {
        this.m_currentBlock.push(new MIRAccessLocalVariable(sinfo, new MIRVariable(name), trgt));
    }

    emitConstructorPrimary(sinfo: SourceInfo, tkey: MIRNominalTypeKey, args: MIRArgument[], trgt: MIRTempRegister) {
        this.m_currentBlock.push(new MIRConstructorPrimary(sinfo, tkey, args, trgt));
    }

    emitInvokeInvariantCheckDirect(sinfo: SourceInfo, ikey: MIRInvokeKey, tkey: MIRNominalTypeKey, rcvr: MIRArgument, trgt: MIRTempRegister) {
        this.m_currentBlock.push(new MIRInvokeInvariantCheckDirect(sinfo, ikey, tkey, rcvr, trgt));
    }

    emitInvokeInvariantCheckVirtualTarget(sinfo: SourceInfo, inferrcvr: MIRResolvedTypeKey, rcvr: MIRArgument, trgt: MIRTempRegister) {
        this.m_currentBlock.push(new MIRInvokeInvariantCheckVirtualTarget(sinfo, inferrcvr, rcvr, trgt));
    }

    emitConstructorPrimaryCollectionEmpty(sinfo: SourceInfo, tkey: MIRNominalTypeKey, trgt: MIRTempRegister) {
        this.m_currentBlock.push(new MIRConstructorPrimaryCollectionEmpty(sinfo, tkey, trgt));
    }

    emitConstructorPrimaryCollectionSingletons(sinfo: SourceInfo, tkey: MIRNominalTypeKey, args: MIRArgument[], trgt: MIRTempRegister) {
        this.m_currentBlock.push(new MIRConstructorPrimaryCollectionSingletons(sinfo, tkey, args, trgt));
    }

    emitConstructorPrimaryCollectionCopies(sinfo: SourceInfo, tkey: MIRNominalTypeKey, args: MIRArgument[], trgt: MIRTempRegister) {
        this.m_currentBlock.push(new MIRConstructorPrimaryCollectionCopies(sinfo, tkey, args, trgt));
    }

    emitConstructorPrimaryCollectionMixed(sinfo: SourceInfo, tkey: MIRNominalTypeKey, args: [boolean, MIRArgument][], trgt: MIRTempRegister) {
        this.m_currentBlock.push(new MIRConstructorPrimaryCollectionMixed(sinfo, tkey, args, trgt));
    }

    emitConstructorTuple(sinfo: SourceInfo, resultTupleType: MIRResolvedTypeKey, args: MIRArgument[], trgt: MIRTempRegister) {
        this.m_currentBlock.push(new MIRConstructorTuple(sinfo, resultTupleType, args, trgt));
    }

    emitConstructorRecord(sinfo: SourceInfo, resultRecordType: MIRResolvedTypeKey, args: [string, MIRArgument][], trgt: MIRTempRegister) {
        this.m_currentBlock.push(new MIRConstructorRecord(sinfo, resultRecordType, args, trgt));
    }

    emitConstructorValueList(sinfo: SourceInfo, resultEphemeralType: MIRResolvedTypeKey, args: MIRArgument[], trgt: MIRTempRegister) {
        this.m_currentBlock.push(new MIRConstructorEphemeralValueList(sinfo, resultEphemeralType, args, trgt));
    }

    emitLoadTupleIndex(sinfo: SourceInfo, resultAccessType: MIRResolvedTypeKey, arg: MIRArgument, argInferType: MIRResolvedTypeKey, idx: number, trgt: MIRTempRegister) {
        this.m_currentBlock.push(new MIRAccessFromIndex(sinfo, resultAccessType, arg, argInferType, idx, trgt));
    }

    emitProjectTupleIndecies(sinfo: SourceInfo, resultProjectType: MIRResolvedTypeKey, arg: MIRArgument, argInferType: MIRResolvedTypeKey, indecies: number[], trgt: MIRTempRegister) {
        this.m_currentBlock.push(new MIRProjectFromIndecies(sinfo, resultProjectType, arg, argInferType, indecies, trgt));
    }

    emitLoadProperty(sinfo: SourceInfo, resultAccessType: MIRResolvedTypeKey, arg: MIRArgument, argInferType: MIRResolvedTypeKey, pname: string, trgt: MIRTempRegister) {
        this.m_currentBlock.push(new MIRAccessFromProperty(sinfo, resultAccessType, arg, argInferType, pname, trgt));
    }

    emitLoadField(sinfo: SourceInfo, resultAccessType: MIRResolvedTypeKey, arg: MIRArgument, argInferType: MIRResolvedTypeKey, fname: MIRFieldKey, trgt: MIRTempRegister) {
        this.m_currentBlock.push(new MIRAccessFromField(sinfo, resultAccessType, arg, argInferType, fname, trgt));
    }

    emitProjectProperties(sinfo: SourceInfo, resultProjectType: MIRResolvedTypeKey, arg: MIRArgument, argInferType: MIRResolvedTypeKey, properties: string[], trgt: MIRTempRegister) {
        this.m_currentBlock.push(new MIRProjectFromProperties(sinfo, resultProjectType, arg, argInferType, properties, trgt));
    }

    emitProjectFields(sinfo: SourceInfo, resultProjectType: MIRResolvedTypeKey, arg: MIRArgument, argInferType: MIRResolvedTypeKey, fields: MIRFieldKey[], trgt: MIRTempRegister) {
        this.m_currentBlock.push(new MIRProjectFromFields(sinfo, resultProjectType, arg, argInferType, fields, trgt));
    }

    emitProjectFromTypeTuple(sinfo: SourceInfo, resultProjectType: MIRResolvedTypeKey, arg: MIRArgument, istry: boolean, argInferType: MIRResolvedTypeKey, ptype: MIRResolvedTypeKey, trgt: MIRTempRegister) {
        this.m_currentBlock.push(new MIRProjectFromTypeTuple(sinfo, resultProjectType, arg, istry, argInferType, ptype, trgt));
    }

    emitProjectFromTypeRecord(sinfo: SourceInfo, resultProjectType: MIRResolvedTypeKey, arg: MIRArgument, istry: boolean, argInferType: MIRResolvedTypeKey, ptype: MIRResolvedTypeKey, trgt: MIRTempRegister) {
        this.m_currentBlock.push(new MIRProjectFromTypeRecord(sinfo, resultProjectType, arg, istry, argInferType, ptype, trgt));
    }

    emitProjectFromTypeNominal(sinfo: SourceInfo, resultProjectType: MIRResolvedTypeKey, arg: MIRArgument, istry: boolean, argInferType: MIRResolvedTypeKey, ptype: MIRNominalTypeKey, cfields: MIRFieldKey[], trgt: MIRTempRegister) {
        this.m_currentBlock.push(new MIRProjectFromTypeNominal(sinfo, resultProjectType, arg, istry, argInferType, ptype, cfields, trgt));
    }

    emitModifyWithIndecies(sinfo: SourceInfo, resultTupleType: MIRResolvedTypeKey, arg: MIRArgument, argInferType: MIRResolvedTypeKey, updates: [number, MIRArgument][], trgt: MIRTempRegister) {
        this.m_currentBlock.push(new MIRModifyWithIndecies(sinfo, resultTupleType, arg, argInferType, updates, trgt));
    }

    emitModifyWithProperties(sinfo: SourceInfo, resultRecordType: MIRResolvedTypeKey, arg: MIRArgument, argInferType: MIRResolvedTypeKey, updates: [string, MIRArgument][], trgt: MIRTempRegister) {
        this.m_currentBlock.push(new MIRModifyWithProperties(sinfo, resultRecordType, arg, argInferType, updates, trgt));
    }

    emitModifyWithFields(sinfo: SourceInfo, resultNominalType: MIRResolvedTypeKey, arg: MIRArgument, argInferType: MIRResolvedTypeKey, updates: [MIRFieldKey, MIRArgument][], trgt: MIRTempRegister) {
        this.m_currentBlock.push(new MIRModifyWithFields(sinfo, resultNominalType, arg, argInferType, updates, trgt));
    }

    emitStructuredExtendTuple(sinfo: SourceInfo, resultTupleType: MIRResolvedTypeKey, arg: MIRArgument, argInferType: MIRResolvedTypeKey, update: MIRArgument, updateInferType: MIRResolvedTypeKey, trgt: MIRTempRegister) {
        this.m_currentBlock.push(new MIRStructuredExtendTuple(sinfo, resultTupleType, arg, argInferType, update, updateInferType, trgt));
    } 

    emitStructuredExtendRecord(sinfo: SourceInfo, resultRecordType: MIRResolvedTypeKey, arg: MIRArgument, argInferType: MIRResolvedTypeKey, update: MIRArgument, updateInferType: MIRResolvedTypeKey, trgt: MIRTempRegister) {
        this.m_currentBlock.push(new MIRStructuredExtendRecord(sinfo, resultRecordType, arg, argInferType, update, updateInferType, trgt));
    }

    emitStructuredExtendObject(sinfo: SourceInfo, resultNominalType: MIRResolvedTypeKey, arg: MIRArgument, argInferType: MIRResolvedTypeKey, update: MIRArgument, updateInferType: MIRResolvedTypeKey, fieldResolves: [string, MIRFieldKey][], trgt: MIRTempRegister) {
        this.m_currentBlock.push(new MIRStructuredExtendObject(sinfo, resultNominalType, arg, argInferType, update, updateInferType, fieldResolves, trgt));
    }

    emitLoadFromEpehmeralList(sinfo: SourceInfo, arg: MIRRegisterArgument, resultType: MIRResolvedTypeKey, argInferType: MIRResolvedTypeKey, idx: number, trgt: MIRTempRegister) {
        this.m_currentBlock.push(new MIRLoadFromEpehmeralList(sinfo, arg, resultType, argInferType, idx, trgt));
    }

    emitInvokeFixedFunction(sinfo: SourceInfo, ikey: MIRInvokeKey, args: MIRArgument[], retinfo: [MIRType, MIRType, number, [string, MIRType][]], trgt: MIRTempRegister) {
        if (retinfo[3].length === 0) {
            this.m_currentBlock.push(new MIRInvokeFixedFunction(sinfo, retinfo[0].trkey, ikey, args, trgt));
        }
        else {
            const rr = this.generateTmpRegister();
            this.m_currentBlock.push(new MIRInvokeFixedFunction(sinfo, retinfo[1].trkey, ikey, args, rr));

            if (retinfo[2] === -1) {
                this.m_currentBlock.push(new MIRLoadFromEpehmeralList(sinfo, rr, retinfo[0].trkey, retinfo[1].trkey, 0, trgt));
            }
            else {
                this.m_currentBlock.push(new MIRPackSlice(sinfo, rr, retinfo[0].trkey, trgt));
            }

            const refbase = retinfo[2] != -1 ? retinfo[2] : 1;
            for (let i = 0; i < retinfo[3].length; ++i) {
                const tr = this.generateTmpRegister();
                this.m_currentBlock.push(new MIRLoadFromEpehmeralList(sinfo, rr, retinfo[3][i][1].trkey, retinfo[1].trkey, refbase + i, tr));
                this.m_currentBlock.push(new MIRVarStore(sinfo, tr, new MIRVariable(retinfo[3][i][0])));
            }
        }
    }

    emitInvokeVirtualTarget(sinfo: SourceInfo, vresolve: MIRVirtualMethodKey, args: MIRArgument[], thisInferType: MIRResolvedTypeKey, retinfo: [MIRType, MIRType, number, [string, MIRType][]], trgt: MIRTempRegister) {
        if (retinfo[3].length === 0) {
            this.m_currentBlock.push(new MIRInvokeVirtualFunction(sinfo, retinfo[0].trkey, vresolve, args, thisInferType, trgt));
        }
        else {
            const rr = this.generateTmpRegister();
            this.m_currentBlock.push(new MIRInvokeVirtualFunction(sinfo, retinfo[1].trkey, vresolve, args, thisInferType, rr));
           
            if (retinfo[2] === -1) {
                this.m_currentBlock.push(new MIRLoadFromEpehmeralList(sinfo, rr, retinfo[0].trkey, retinfo[1].trkey, 0, trgt));
            }
            else {
                this.m_currentBlock.push(new MIRPackSlice(sinfo, rr, retinfo[0].trkey, trgt));
            }

            const refbase = retinfo[2] != -1 ? retinfo[2] : 1;
            for (let i = 0; i < retinfo[3].length; ++i) {
                const tr = this.generateTmpRegister();
                this.m_currentBlock.push(new MIRLoadFromEpehmeralList(sinfo, rr, retinfo[3][i][1].trkey, retinfo[1].trkey, refbase + i, tr));
                this.m_currentBlock.push(new MIRVarStore(sinfo, tr, new MIRVariable(retinfo[3][i][0])));
            }
        }
    }

    emitPrefixNot(sinfo: SourceInfo, op: string, isstrict: boolean, arg: MIRArgument, infertype: MIRResolvedTypeKey, trgt: MIRTempRegister) {
        if(isstrict) {
            this.m_currentBlock.push(new MIRPrefixOp(sinfo, op, arg, infertype, trgt));
        }
        else {
            const tr = this.generateTmpRegister();
            this.m_currentBlock.push(new MIRTruthyConvert(sinfo, arg, tr));
            this.m_currentBlock.push(new MIRPrefixOp(sinfo, op, tr, infertype, trgt));
        }
    }

    emitPrefixOp(sinfo: SourceInfo, op: string, arg: MIRArgument, infertype: MIRResolvedTypeKey, trgt: MIRTempRegister) {
        this.m_currentBlock.push(new MIRPrefixOp(sinfo, op, arg, infertype, trgt));
    }

    emitBinOp(sinfo: SourceInfo, lhsInferType: MIRResolvedTypeKey, lhs: MIRArgument, op: string, rhsInferType: MIRResolvedTypeKey, rhs: MIRArgument, trgt: MIRTempRegister) {
        this.m_currentBlock.push(new MIRBinOp(sinfo, lhsInferType, lhs, op, rhsInferType, rhs, trgt));
    }

    emitBinEq(sinfo: SourceInfo, lhsInferType: MIRResolvedTypeKey, lhs: MIRArgument, op: string, rhsInferType: MIRResolvedTypeKey, rhs: MIRArgument, trgt: MIRTempRegister, relaxed: boolean) {
        this.m_currentBlock.push(new MIRBinEq(sinfo, lhsInferType, lhs, op, rhsInferType, rhs, trgt, relaxed));
    }

    emitBinLess(sinfo: SourceInfo, lhsInferType: MIRResolvedTypeKey, lhs: MIRArgument, op: string, rhsInferType: MIRResolvedTypeKey, rhs: MIRArgument, trgt: MIRTempRegister, relaxed: boolean) {
        this.m_currentBlock.push(new MIRBinLess(sinfo, lhsInferType, lhs, rhsInferType, rhs, trgt, relaxed));
    }

    emitBinCmp(sinfo: SourceInfo, lhsInferType: MIRResolvedTypeKey, lhs: MIRArgument, op: string, rhsInferType: MIRResolvedTypeKey, rhs: MIRArgument, trgt: MIRTempRegister) {
        this.m_currentBlock.push(new MIRBinCmp(sinfo, lhsInferType, lhs, op, rhsInferType, rhs, trgt));
    }

    emitTypeOf(sinfo: SourceInfo, trgt: MIRTempRegister, chktype: MIRResolvedTypeKey, srcInferType: MIRResolvedTypeKey, src: MIRArgument) {
        if (chktype === "NSCore::None") {
            this.m_currentBlock.push(new MIRIsTypeOfNone(sinfo, src, trgt));
        }
        else if (chktype === "NSCore::Some") {
            this.m_currentBlock.push(new MIRIsTypeOfSome(sinfo, src, trgt));
        }
        else {
            this.m_currentBlock.push(new MIRIsTypeOf(sinfo, srcInferType, src, chktype, trgt));
        }
    }

    emitRegAssign(sinfo: SourceInfo, src: MIRArgument, trgt: MIRTempRegister) {
        this.m_currentBlock.push(new MIRRegAssign(sinfo, src, trgt));
    }

    emitTruthyConversion(sinfo: SourceInfo, src: MIRTempRegister, trgt: MIRTempRegister) {
        this.m_currentBlock.push(new MIRTruthyConvert(sinfo, src, trgt));
    }

    localLifetimeStart(sinfo: SourceInfo, name: string, rtkey: MIRResolvedTypeKey) {
        this.m_currentBlock.push(new MIRVarLifetimeStart(sinfo, name, rtkey));
    }

    emitVarStore(sinfo: SourceInfo, src: MIRTempRegister, name: string) {
        this.m_currentBlock.push(new MIRVarStore(sinfo, src, new MIRVariable(name)));
    }

    emitArgVarStore(sinfo: SourceInfo, src: string, name: string) {
        this.m_currentBlock.push(new MIRVarStore(sinfo, new MIRVariable(src), new MIRVariable(name)));
    }

    emitVarMove(sinfo: SourceInfo, src: string, name: string) {
        this.m_currentBlock.push(new MIRVarStore(sinfo, new MIRVariable(src), new MIRVariable(name)));
    }

    emitMIRPackExtend(sinfo: SourceInfo, basepack: MIRArgument, ext: MIRArgument[], sltype: MIRResolvedTypeKey, trgt: MIRTempRegister) {
        this.m_currentBlock.push(new MIRPackExtend(sinfo, basepack, ext, sltype, trgt));
    }

    localLifetimeEnd(sinfo: SourceInfo, name: string) {
        this.m_currentBlock.push(new MIRVarLifetimeEnd(sinfo, name));
    }

    emitReturnAssign(sinfo: SourceInfo, src: MIRArgument) {
        this.m_currentBlock.push(new MIRReturnAssign(sinfo, src));
    }

    emitAbort(sinfo: SourceInfo, info: string) {
        this.m_currentBlock.push(new MIRAbort(sinfo, info));
    }

    emitDebugBreak(sinfo: SourceInfo) {
        this.m_currentBlock.push(new MIRDebug(sinfo, undefined));
    }

    emitDebugPrint(sinfo: SourceInfo, value: MIRArgument) {
        this.m_currentBlock.push(new MIRDebug(sinfo, value));
    }

    emitDirectJump(sinfo: SourceInfo, blck: string) {
        this.m_currentBlock.push(new MIRJump(sinfo, blck));
    }

    emitBoolJump(sinfo: SourceInfo, arg: MIRTempRegister, isstrict: boolean, trueblck: string, falseblck: string) {
        if(isstrict) {
            this.m_currentBlock.push(new MIRJumpCond(sinfo, arg, trueblck, falseblck));
        } 
        else {
            const tr = this.generateTmpRegister();
            this.m_currentBlock.push(new MIRTruthyConvert(sinfo, arg, tr));
            this.m_currentBlock.push(new MIRJumpCond(sinfo, tr, trueblck, falseblck));
        }
    }

    emitNoneJump(sinfo: SourceInfo, arg: MIRTempRegister, noneblck: string, someblk: string, ) {
        this.m_currentBlock.push(new MIRJumpNone(sinfo, arg, noneblck, someblk));
    }

    getBody(file: string, sinfo: SourceInfo, args: Map<string, MIRType>): MIRBody {
        let ibody = new MIRBody(file, sinfo, this.m_blockMap);

        propagateTmpAssignForBody(ibody);
        removeDeadTempAssignsFromBody(ibody);

        convertBodyToSSA(ibody, args);

        return ibody;
    }
}

class MIREmitter {
    readonly masm: MIRAssembly;
    readonly bodyEmitter: MIRBodyEmitter = new MIRBodyEmitter();

    private readonly pendingOOProcessing: [MIRNominalTypeKey, OOPTypeDecl, Map<string, ResolvedType>][] = [];

    private readonly pendingGlobalProcessing: [MIRConstantKey, NamespaceConstDecl][] = [];
    private readonly pendingConstProcessing: [MIRConstantKey, OOPTypeDecl, StaticMemberDecl, Map<string, ResolvedType>][] = [];

    private readonly pendingOOStaticProcessing: [MIRInvokeKey, OOPTypeDecl, Map<string, ResolvedType>, StaticFunctionDecl, Map<string, ResolvedType>, PCode[], [string, ResolvedType][]][] = [];
    private readonly pendingOOMethodProcessing: [MIRVirtualMethodKey, MIRInvokeKey, OOPTypeDecl, Map<string, ResolvedType>, MemberMethodDecl, Map<string, ResolvedType>, PCode[], [string, ResolvedType][]][] = [];
    private readonly pendingFunctionProcessing: [MIRInvokeKey, NamespaceFunctionDecl, Map<string, ResolvedType>, PCode[], [string, ResolvedType][]][] = [];
    private readonly pendingPCodeProcessing: [MIRInvokeKey, InvokeDecl, ResolvedFunctionType, Map<string, ResolvedType>, [string, ResolvedType][]][] = [];

    private readonly entityInstantiationInfo: [MIRResolvedTypeKey, OOPTypeDecl, Map<string, ResolvedType>][] = [];
    private readonly allVInvokes: [MIRVirtualMethodKey, MIRNominalTypeKey, OOPTypeDecl, Map<string, ResolvedType>, string, Map<string, ResolvedType>, PCode[], [string, ResolvedType][]][] = [];

    private constructor(masm: MIRAssembly) {
        this.masm = masm;
    }

    initializeBodyEmitter() {
        this.bodyEmitter.initialize();
    }

    getVCallInstantiations(assembly: Assembly): [MIRVirtualMethodKey, MIRInvokeKey, OOPTypeDecl, Map<string, ResolvedType>, MemberMethodDecl, Map<string, ResolvedType>, PCode[], [string, ResolvedType][]][] | undefined {
        if (this.allVInvokes.length === 0) {
            return undefined;
        }

        let resvi = new Map<string, [MIRVirtualMethodKey, MIRInvokeKey, OOPTypeDecl, Map<string, ResolvedType>, MemberMethodDecl, Map<string, ResolvedType>, PCode[], [string, ResolvedType][]]>();
        for (let i = 0; i < this.allVInvokes.length; ++i) {
            const vinv = this.allVInvokes[i];

            const vcpt = ResolvedType.createSingle(ResolvedConceptAtomType.create([ResolvedConceptAtomTypeEntry.create(vinv[2] as ConceptTypeDecl, vinv[3])]));
            const impls = this.entityInstantiationInfo.filter((iinfo) => {
                if (iinfo[1] instanceof EntityTypeDecl) {
                    const etype = ResolvedType.createSingle(ResolvedEntityAtomType.create(iinfo[1] as EntityTypeDecl, iinfo[2]));
                    return assembly.subtypeOf(etype, vcpt);
                }
                else {
                    const cpt = ResolvedConceptAtomType.create([ResolvedConceptAtomTypeEntry.create(iinfo[1] as ConceptTypeDecl, iinfo[2])]);
                    const ctype = ResolvedType.createSingle(cpt);
                    return assembly.subtypeOf(ctype, vcpt);
                }
            });

            for (let j = 0; j < impls.length; ++j) {
                const impl = impls[j];
                const itype = ResolvedType.createSingle(ResolvedEntityAtomType.create(impl[1] as EntityTypeDecl, impl[2]));

                const mcreate = assembly.tryGetOOMemberDeclUnique(itype, "method", vinv[4]);
                if (mcreate !== undefined) {
                    const binds = new Map<string, ResolvedType>(mcreate.binds);
                    vinv[5].forEach((v, k) => binds.set(k, v));

                    const mkey = MIRKeyGenerator.generateMethodKey(mcreate.contiainingType, (mcreate.decl as MemberMethodDecl).name, mcreate.binds, vinv[6]);
                    if (!resvi.has(mkey)) {
                        resvi.set(mkey, [vinv[0], mkey, mcreate.contiainingType, mcreate.binds, mcreate.decl as MemberMethodDecl, binds as Map<string, ResolvedType>, vinv[6], vinv[7]]);
                    }
                }
            }
        }

        let fres: [MIRVirtualMethodKey, MIRInvokeKey, OOPTypeDecl, Map<string, ResolvedType>, MemberMethodDecl, Map<string, ResolvedType>, PCode[], [string, ResolvedType][]][] = [];
        resvi.forEach((v, k) => fres.push(v));

        return fres;
    }

    registerTypeInstantiation(decl: OOPTypeDecl, binds: Map<string, ResolvedType>) {
        const key = MIRKeyGenerator.generateTypeKey(decl, binds);
        if (this.masm.conceptDecls.has(key) || this.masm.entityDecls.has(key) || this.pendingOOProcessing.findIndex((oop) => oop[0] === key) !== -1) {
            return;
        }

        this.pendingOOProcessing.push([key, decl, binds]);
        this.entityInstantiationInfo.push([key, decl, binds]);
    }

    registerResolvedTypeReference(t: ResolvedType): MIRType {
        if (t.options.length > 1) {
            const oopts = t.options.map((opt) => this.registerResolvedTypeReference(ResolvedType.createSingle(opt)).options);
            const ft = MIRType.create(([] as MIRTypeOption[]).concat(...oopts));

            this.masm.typeMap.set(ft.trkey, ft);
            return ft;
        }
        else {
            const sopt = t.options[0];
            let rt: MIRTypeOption | undefined = undefined;

            if (sopt instanceof ResolvedEntityAtomType) {
                this.registerTypeInstantiation(sopt.object, sopt.binds);
                rt = MIREntityType.create(MIRKeyGenerator.generateTypeKey(sopt.object, sopt.binds));
            }
            else if (sopt instanceof ResolvedConceptAtomType) {
                if(sopt.conceptTypes.length > 1) {
                    sopt.conceptTypes.forEach((opt) => this.registerResolvedTypeReference(ResolvedType.createSingle(ResolvedConceptAtomType.create([opt]))));
                }
                const natoms = sopt.conceptTypes.map((cpt) => {
                    this.registerTypeInstantiation(cpt.concept, cpt.binds);
                    return MIRKeyGenerator.generateTypeKey(cpt.concept, cpt.binds);
                });
                rt = MIRConceptType.create(natoms);
            }
            else if (sopt instanceof ResolvedTupleAtomType) {
                const tatoms = sopt.types.map((entry) => new MIRTupleTypeEntry(this.registerResolvedTypeReference(entry.type), entry.isOptional));
                rt = MIRTupleType.create(tatoms);
            }
            else if (sopt instanceof ResolvedRecordAtomType) {
                const tatoms = sopt.entries.map((entry) => new MIRRecordTypeEntry(entry.name, this.registerResolvedTypeReference(entry.type), entry.isOptional));
                rt = MIRRecordType.create(tatoms);
            }
            else {
                const vpatoms = (sopt as ResolvedEphemeralListType).types.map((tt) => this.registerResolvedTypeReference(tt));
                rt = MIREphemeralListType.create(vpatoms);
            }

            const ft = MIRType.create([(rt as MIRTypeOption)]);
            this.masm.typeMap.set(ft.trkey, ft);
            return ft;
        }
    }

    registerPendingGlobalProcessing(decl: NamespaceConstDecl): MIRConstantKey {
        const key = MIRKeyGenerator.generateGlobalKey(decl.ns, decl.name);
        if (this.masm.constantDecls.has(key) || this.pendingGlobalProcessing.findIndex((gp) => gp[0] === key) !== -1) {
            return key;
        }

        this.pendingGlobalProcessing.push([key, decl]);
        return key;
    }

    registerPendingConstProcessing(containingType: OOPTypeDecl, decl: StaticMemberDecl, binds: Map<string, ResolvedType>): MIRConstantKey {
        const key = MIRKeyGenerator.generateConstKey(containingType, binds, decl.name);
        if (this.masm.constantDecls.has(key) || this.pendingConstProcessing.findIndex((cp) => cp[0] === key) !== -1) {
            return key;
        }

        this.pendingConstProcessing.push([key, containingType, decl, binds]);
        return key;
    }

    registerFunctionCall(ns: string, name: string, f: NamespaceFunctionDecl, binds: Map<string, ResolvedType>, pcodes: PCode[], cinfo: [string, ResolvedType][]): MIRInvokeKey {
        const key = MIRKeyGenerator.generateFunctionKey(ns, name, binds, pcodes);
        if (this.masm.invokeDecls.has(key) || this.masm.primitiveInvokeDecls.has(key) || this.pendingFunctionProcessing.findIndex((fp) => fp[0] === key) !== -1) {
            return key;
        }

        this.pendingFunctionProcessing.push([key, f, binds, pcodes, cinfo]);
        return key;
    }

    registerStaticCall(containingType: OOPTypeDecl, cbinds: Map<string, ResolvedType>, f: StaticFunctionDecl, name: string, binds: Map<string, ResolvedType>, pcodes: PCode[], cinfo: [string, ResolvedType][]): MIRInvokeKey {
        const key = MIRKeyGenerator.generateStaticKey(containingType, name, binds, pcodes);
        if (this.masm.invokeDecls.has(key) || this.masm.primitiveInvokeDecls.has(key) || this.pendingOOStaticProcessing.findIndex((sp) => sp[0] === key) !== -1) {
            return key;
        }

        this.pendingOOStaticProcessing.push([key, containingType, cbinds, f, binds, pcodes, cinfo]);
        return key;
    }

    registerMethodCall(containingType: OOPTypeDecl, m: MemberMethodDecl, cbinds: Map<string, ResolvedType>, name: string, binds: Map<string, ResolvedType>, pcodes: PCode[], cinfo: [string, ResolvedType][]): MIRInvokeKey {
        const vkey = MIRKeyGenerator.generateVirtualMethodKey(name, binds);
        const key = MIRKeyGenerator.generateMethodKey(containingType, name, binds, pcodes);
        if (this.masm.invokeDecls.has(key) || this.masm.primitiveInvokeDecls.has(key) || this.pendingOOMethodProcessing.findIndex((mp) => mp[1] === key) !== -1) {
            return key;
        }

        this.pendingOOMethodProcessing.push([vkey, key, containingType, cbinds, m, binds, pcodes, cinfo]);
        return key;
    }

    registerVirtualMethodCall(containingType: OOPTypeDecl, cbinds: Map<string, ResolvedType>, name: string, binds: Map<string, ResolvedType>, pcodes: PCode[], cinfo: [string, ResolvedType][]): MIRInvokeKey {
        const key = MIRKeyGenerator.generateVirtualMethodKey(name, binds);
        const tkey = MIRKeyGenerator.generateTypeKey(containingType, binds);
        if (this.allVInvokes.findIndex((vi) => vi[0] === key && vi[1] === tkey) !== -1) {
            return key;
        }

        this.allVInvokes.push([key, tkey, containingType, cbinds, name, binds, pcodes, cinfo]);
        return key;
    }

    registerPCode(idecl: InvokeDecl, fsig: ResolvedFunctionType, binds: Map<string, ResolvedType>, cinfo: [string, ResolvedType][]): MIRInvokeKey {
        const key = MIRKeyGenerator.generatePCodeKey(idecl);
        if (this.masm.invokeDecls.has(key) || this.masm.primitiveInvokeDecls.has(key) || this.pendingPCodeProcessing.findIndex((fp) => fp[0] === key) !== -1) {
            return key;
        }

        this.pendingPCodeProcessing.push([key, idecl, fsig, binds, cinfo]);
        return key;
    }

    private closeConceptDecl( cpt: MIRConceptTypeDecl) {
        cpt.provides.forEach((tkey) => {
            const ccdecl = this.masm.conceptDecls.get(tkey) as MIRConceptTypeDecl;
            this.closeConceptDecl(ccdecl);

            ccdecl.vcallMap.forEach((vcall, vcname) => {
                if (!cpt.vcallMap.has(vcname)) {
                    cpt.vcallMap.set(vcname, vcall);
                }
            });
        });
    }

    private closeEntityDecl(entity: MIREntityTypeDecl) {
        entity.provides.forEach((tkey) => {
            const ccdecl = this.masm.conceptDecls.get(tkey) as MIRConceptTypeDecl;
            this.closeConceptDecl(ccdecl);

            ccdecl.vcallMap.forEach((vcall, vcname) => {
                if (!entity.vcallMap.has(vcname)) {
                    entity.vcallMap.set(vcname, vcall);
                }
            });
        });
    }

    static generateMASM(pckge: PackageConfig, buildLevel: BuildLevel, validateLiteralStrings: boolean, functionalize: boolean, srcFiles: { relativePath: string, contents: string }[]): { masm: MIRAssembly | undefined, errors: string[] } {
        ////////////////
        //Parse the contents and generate the assembly
        const assembly = new Assembly();
        let p = new Parser(assembly);
        try {
            for (let i = 0; i < srcFiles.length; ++i) {
                p.parseCompilationUnitPass1(srcFiles[i].relativePath, srcFiles[i].contents);
            }

            for (let i = 0; i < srcFiles.length; ++i) {
                p.parseCompilationUnitPass2(srcFiles[i].relativePath, srcFiles[i].contents);
            }
        }
        catch (ex) {
            return { masm: undefined, errors: [`Hard failure in parse with exception -- ${ex}`] };
        }

        const parseErrors = p.getParseErrors();
        if (parseErrors !== undefined) {
            return { masm: undefined, errors: parseErrors.map((err: [string, number, string]) => JSON.stringify(err)) };
        }

        ////////////////
        //Compute the assembly hash and initialize representations
        const hash = Crypto.createHash("sha512");
        const data = [...srcFiles].sort((a, b) => a.relativePath.localeCompare(b.relativePath));
        data.forEach((sf) => {
            hash.update(sf.relativePath);
            hash.update(sf.contents);
        });

        const masm = new MIRAssembly(pckge, srcFiles, hash.digest("hex"));
        const emitter = new MIREmitter(masm);
        const checker = new TypeChecker(assembly, true, emitter, buildLevel, validateLiteralStrings);

        emitter.registerTypeInstantiation(assembly.tryGetConceptTypeForFullyResolvedName("NSCore::Any") as ConceptTypeDecl, new Map<string, ResolvedType>());
        emitter.registerResolvedTypeReference(assembly.getSpecialAnyConceptType());
        emitter.registerTypeInstantiation(assembly.tryGetConceptTypeForFullyResolvedName("NSCore::Some") as ConceptTypeDecl, new Map<string, ResolvedType>());
        emitter.registerResolvedTypeReference(assembly.getSpecialSomeConceptType());
        emitter.registerTypeInstantiation(assembly.tryGetConceptTypeForFullyResolvedName("NSCore::Convertable") as ConceptTypeDecl, new Map<string, ResolvedType>());
        emitter.registerResolvedTypeReference(assembly.getSpecialConvertableConceptType());
        emitter.registerTypeInstantiation(assembly.tryGetConceptTypeForFullyResolvedName("NSCore::Parsable") as ConceptTypeDecl, new Map<string, ResolvedType>());
        emitter.registerResolvedTypeReference(assembly.getSpecialParsableConceptType());
        emitter.registerTypeInstantiation(assembly.tryGetConceptTypeForFullyResolvedName("NSCore::Validator") as ConceptTypeDecl, new Map<string, ResolvedType>());
        emitter.registerResolvedTypeReference(assembly.getSpecialValidatorConceptType());
        emitter.registerTypeInstantiation(assembly.tryGetConceptTypeForFullyResolvedName("NSCore::KeyType") as ConceptTypeDecl, new Map<string, ResolvedType>());
        emitter.registerResolvedTypeReference(assembly.getSpecialKeyTypeConceptType());
        emitter.registerTypeInstantiation(assembly.tryGetConceptTypeForFullyResolvedName("NSCore::PODType") as ConceptTypeDecl, new Map<string, ResolvedType>());
        emitter.registerResolvedTypeReference(assembly.getSpecialPODTypeConceptType());
        emitter.registerTypeInstantiation(assembly.tryGetConceptTypeForFullyResolvedName("NSCore::APIType") as ConceptTypeDecl, new Map<string, ResolvedType>());
        emitter.registerResolvedTypeReference(assembly.getSpecialAPITypeConceptType());
        emitter.registerTypeInstantiation(assembly.tryGetConceptTypeForFullyResolvedName("NSCore::APIValue") as ConceptTypeDecl, new Map<string, ResolvedType>());
        emitter.registerResolvedTypeReference(assembly.getSpecialAPIValueConceptType());
        emitter.registerTypeInstantiation(assembly.tryGetConceptTypeForFullyResolvedName("NSCore::Truthy") as ConceptTypeDecl, new Map<string, ResolvedType>());
        emitter.registerResolvedTypeReference(assembly.getSpecialTruthyConceptType());
        emitter.registerTypeInstantiation(assembly.tryGetConceptTypeForFullyResolvedName("NSCore::Enum") as ConceptTypeDecl, new Map<string, ResolvedType>());
        emitter.registerResolvedTypeReference(assembly.getSpecialEnumConceptType());
        emitter.registerTypeInstantiation(assembly.tryGetConceptTypeForFullyResolvedName("NSCore::IdKey") as ConceptTypeDecl, new Map<string, ResolvedType>());
        emitter.registerResolvedTypeReference(assembly.getSpecialIdKeyConceptType());
        emitter.registerTypeInstantiation(assembly.tryGetConceptTypeForFullyResolvedName("NSCore::Tuple") as ConceptTypeDecl, new Map<string, ResolvedType>());
        emitter.registerResolvedTypeReference(assembly.getSpecialTupleConceptType());
        emitter.registerTypeInstantiation(assembly.tryGetConceptTypeForFullyResolvedName("NSCore::Record") as ConceptTypeDecl, new Map<string, ResolvedType>());
        emitter.registerResolvedTypeReference(assembly.getSpecialRecordConceptType());
        emitter.registerTypeInstantiation(assembly.tryGetConceptTypeForFullyResolvedName("NSCore::Object") as ConceptTypeDecl, new Map<string, ResolvedType>());
        emitter.registerResolvedTypeReference(assembly.getSpecialObjectConceptType());

        emitter.registerTypeInstantiation(assembly.tryGetObjectTypeForFullyResolvedName("NSCore::None") as EntityTypeDecl, new Map<string, ResolvedType>());
        emitter.registerResolvedTypeReference(assembly.getSpecialNoneType());
        emitter.registerTypeInstantiation(assembly.tryGetObjectTypeForFullyResolvedName("NSCore::Bool") as EntityTypeDecl, new Map<string, ResolvedType>());
        emitter.registerResolvedTypeReference(assembly.getSpecialBoolType());
        emitter.registerTypeInstantiation(assembly.tryGetObjectTypeForFullyResolvedName("NSCore::Int") as EntityTypeDecl, new Map<string, ResolvedType>());
        emitter.registerResolvedTypeReference(assembly.getSpecialIntType());
        emitter.registerTypeInstantiation(assembly.tryGetObjectTypeForFullyResolvedName("NSCore::BigInt") as EntityTypeDecl, new Map<string, ResolvedType>());
        emitter.registerResolvedTypeReference(assembly.getSpecialBigIntType());
        emitter.registerTypeInstantiation(assembly.tryGetObjectTypeForFullyResolvedName("NSCore::Float64") as EntityTypeDecl, new Map<string, ResolvedType>());
        emitter.registerResolvedTypeReference(assembly.getSpecialFloat64Type());
        emitter.registerTypeInstantiation(assembly.tryGetObjectTypeForFullyResolvedName("NSCore::String") as EntityTypeDecl, new Map<string, ResolvedType>());
        emitter.registerResolvedTypeReference(assembly.getSpecialStringType());
        emitter.registerTypeInstantiation(assembly.tryGetObjectTypeForFullyResolvedName("NSCore::BufferFormat") as EntityTypeDecl, new Map<string, ResolvedType>());
        emitter.registerResolvedTypeReference(assembly.getSpecialBufferFormatType());
        emitter.registerTypeInstantiation(assembly.tryGetObjectTypeForFullyResolvedName("NSCore::BufferEncoding") as EntityTypeDecl, new Map<string, ResolvedType>());
        emitter.registerResolvedTypeReference(assembly.getSpecialBufferEncodingType());
        emitter.registerTypeInstantiation(assembly.tryGetObjectTypeForFullyResolvedName("NSCore::BufferCompression") as EntityTypeDecl, new Map<string, ResolvedType>());
        emitter.registerResolvedTypeReference(assembly.getSpecialBufferCompressionType());
        emitter.registerTypeInstantiation(assembly.tryGetObjectTypeForFullyResolvedName("NSCore::ByteBuffer") as EntityTypeDecl, new Map<string, ResolvedType>());
        emitter.registerResolvedTypeReference(assembly.getSpecialByteBufferType());
        emitter.registerTypeInstantiation(assembly.tryGetObjectTypeForFullyResolvedName("NSCore::ISOTime") as EntityTypeDecl, new Map<string, ResolvedType>());
        emitter.registerResolvedTypeReference(assembly.getSpecialISOTimeType());
        emitter.registerTypeInstantiation(assembly.tryGetObjectTypeForFullyResolvedName("NSCore::UUID") as EntityTypeDecl, new Map<string, ResolvedType>());
        emitter.registerResolvedTypeReference(assembly.getSpecialUUIDType());
        emitter.registerTypeInstantiation(assembly.tryGetObjectTypeForFullyResolvedName("NSCore::LogicalTime") as EntityTypeDecl, new Map<string, ResolvedType>());
        emitter.registerResolvedTypeReference(assembly.getSpecialLogicalTimeType());
        emitter.registerTypeInstantiation(assembly.tryGetObjectTypeForFullyResolvedName("NSCore::CryptoHash") as EntityTypeDecl, new Map<string, ResolvedType>());
        emitter.registerResolvedTypeReference(assembly.getSpecialCryptoHashType());
        emitter.registerTypeInstantiation(assembly.tryGetObjectTypeForFullyResolvedName("NSCore::Regex") as EntityTypeDecl, new Map<string, ResolvedType>());
        emitter.registerResolvedTypeReference(assembly.getSpecialRegexType());

        //get any entrypoint functions and initialize the checker there
        const nslist = assembly.getNamespaces();
        nslist.forEach((nsentry) => {
            nsentry.functions.forEach((f) => {
                if (f.attributes.indexOf("entrypoint") !== -1) {
                    emitter.registerFunctionCall(f.ns, f.name, f, new Map<string, ResolvedType>(), [], []);
                }
            });
        });

        ////////////////
        //While there is more to process get an item and run the checker on it
        try {
            let lastVCount = 0;
            while (true) {
                while (emitter.pendingOOProcessing.length !== 0 ||
                    emitter.pendingGlobalProcessing.length !== 0 || emitter.pendingConstProcessing.length !== 0 ||
                    emitter.pendingFunctionProcessing.length !== 0 || emitter.pendingPCodeProcessing.length !== 0 ||
                    emitter.pendingOOStaticProcessing.length !== 0 || emitter.pendingOOMethodProcessing.length !== 0) {

                    while (emitter.pendingOOProcessing.length !== 0) {
                        const tt = emitter.pendingOOProcessing.pop() as [MIRResolvedTypeKey, OOPTypeDecl, Map<string, ResolvedType>];
                        checker.processOOType(...tt);
                    }

                    while (emitter.pendingGlobalProcessing.length !== 0 || emitter.pendingConstProcessing.length !== 0) {
                        if (emitter.pendingGlobalProcessing.length !== 0) {
                            const pg = emitter.pendingGlobalProcessing.pop() as [MIRConstantKey, NamespaceConstDecl];
                            checker.processGlobal(...pg);
                        }
                        if (emitter.pendingConstProcessing.length !== 0) {
                            const pc = emitter.pendingConstProcessing.pop() as [MIRConstantKey, OOPTypeDecl, StaticMemberDecl, Map<string, ResolvedType>];
                            checker.processConst(...pc);
                        }
                    }

                    if (emitter.pendingFunctionProcessing.length !== 0) {
                        const pf = emitter.pendingFunctionProcessing.pop() as [MIRInvokeKey, NamespaceFunctionDecl, Map<string, ResolvedType>, PCode[], [string, ResolvedType][]];
                        checker.processNamespaceFunction(...pf);
                    }
                    else if (emitter.pendingPCodeProcessing.length !== 0) {
                        const lf = emitter.pendingPCodeProcessing.pop() as [MIRInvokeKey, InvokeDecl, ResolvedFunctionType, Map<string, ResolvedType>, [string, ResolvedType][]];
                        checker.processLambdaFunction(...lf);
                    }
                    else if (emitter.pendingOOStaticProcessing.length !== 0) {
                        const sf = emitter.pendingOOStaticProcessing.pop() as [MIRInvokeKey, OOPTypeDecl, Map<string, ResolvedType>, StaticFunctionDecl, Map<string, ResolvedType>, PCode[], [string, ResolvedType][]];
                        checker.processStaticFunction(...sf);
                    }
                    else if (emitter.pendingOOMethodProcessing.length !== 0) {
                        const mf = emitter.pendingOOMethodProcessing.pop() as [MIRVirtualMethodKey, MIRInvokeKey, OOPTypeDecl, Map<string, ResolvedType>, MemberMethodDecl, Map<string, ResolvedType>, PCode[], [string, ResolvedType][]];
                        checker.processMethodFunction(...mf);
                    }
                    else {
                        //nop
                    }
                }

                //make sure all vcall candidates are processed
                const vcgens = emitter.getVCallInstantiations(assembly);
                if (vcgens === undefined || vcgens.length === lastVCount) {
                    break;
                }
                lastVCount = vcgens.length;

                for (let i = 0; i < vcgens.length; ++i) {
                    checker.processMethodFunction(...vcgens[i]);
                }
            }

            if (checker.getErrorList().length === 0) {
                checker.processRegexInfo();
                checker.runFinalExhaustiveChecks();

                //compute closed field and vtable info
                masm.conceptDecls.forEach((cpt) => emitter.closeConceptDecl(cpt));
                masm.entityDecls.forEach((entity) => emitter.closeEntityDecl(entity));

                masm.invokeDecls.forEach((idecl) => {
                    const args = new Map<string, MIRType>();
                    idecl.params.forEach((param) => args.set(param.name, masm.typeMap.get(param.type) as MIRType));
                    computeVarTypesForInvoke(idecl.body, args, masm.typeMap.get(idecl.resultType) as MIRType, masm);
                });

                if (functionalize) {
                    functionalizeInvokes(masm);
                }
            }
        }
        catch (ex) {
            //ignore
        }

        const tcerrors = checker.getErrorList();
        if (tcerrors.length !== 0) {
            return { masm: undefined, errors: tcerrors.map((err: [string, number, string]) => JSON.stringify(err)) };
        }
        else {
            return { masm: masm, errors: [] };
        }
    }
}

export { PCode, MIRKeyGenerator, MIRBodyEmitter, MIREmitter };
