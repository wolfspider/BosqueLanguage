//-------------------------------------------------------------------------------------------------------
// Copyright (C) Microsoft. All rights reserved.
// Licensed under the MIT license. See LICENSE.txt file in the project root for full license information.
//-------------------------------------------------------------------------------------------------------

class TypeSignature {
}

class ParseErrorTypeSignature extends TypeSignature {
}

class AutoTypeSignature extends TypeSignature {
}

class TemplateTypeSignature extends TypeSignature {
    readonly name: string;

    constructor(name: string) {
        super();
        this.name = name;
    }
}

class NominalTypeSignature extends TypeSignature {
    readonly nameSpace: string;
    readonly baseName: string;
    readonly terms: TypeSignature[];

    constructor(ns: string, base: string, terms?: TypeSignature[]) {
        super();
        this.nameSpace = ns;
        this.baseName = base;
        this.terms = terms || [];
    }
}

class TupleTypeSignature extends TypeSignature {
    readonly entries: [TypeSignature, boolean][];

    constructor(entries: [TypeSignature, boolean][]) {
        super();
        this.entries = entries;
    }
}

class RecordTypeSignature extends TypeSignature {
   readonly entries: [string, TypeSignature, boolean][];

    constructor(entries: [string, TypeSignature, boolean][]) {
        super();
        this.entries = entries;
    }
}

class EphemeralListTypeSignature extends TypeSignature {
    readonly entries: TypeSignature[];

    constructor(entries: TypeSignature[]) {
        super();
        this.entries = entries;
    }
}

class FunctionParameter {
    readonly name: string;
    readonly type: TypeSignature;
    readonly isRef: boolean;
    readonly isOptional: boolean;

    constructor(name: string, type: TypeSignature, isOpt: boolean, isRef: boolean) {
        this.name = name;
        this.type = type;
        this.isOptional = isOpt;
        this.isRef = isRef;
    }
}

class FunctionTypeSignature extends TypeSignature {
    readonly recursive: "yes" | "no" | "cond";
    readonly params: FunctionParameter[];
    readonly optRestParamName: string | undefined;
    readonly optRestParamType: TypeSignature | undefined;
    readonly resultType: TypeSignature;

    constructor(recursive: "yes" | "no" | "cond", params: FunctionParameter[], optRestParamName: string | undefined, optRestParamType: TypeSignature | undefined, resultType: TypeSignature) {
        super();
        this.recursive = recursive;
        this.params = params;
        this.optRestParamName = optRestParamName;
        this.optRestParamType = optRestParamType;
        this.resultType = resultType;
    }
}

class ProjectTypeSignature extends TypeSignature {
    readonly fromtype: TypeSignature;
    readonly oftype: TypeSignature;

    constructor(fromtype: TypeSignature, oftype: TypeSignature) {
        super();
        this.fromtype = fromtype;
        this.oftype = oftype;
    }
}

class IntersectionTypeSignature extends TypeSignature {
    readonly types: TypeSignature[];

    constructor(types: TypeSignature[]) {
        super();
        this.types = types;
    }
}

class UnionTypeSignature extends TypeSignature {
    readonly types: TypeSignature[];

    constructor(types: TypeSignature[]) {
        super();
        this.types = types;
    }
}

export { 
    TypeSignature, ParseErrorTypeSignature, AutoTypeSignature, 
    TemplateTypeSignature, NominalTypeSignature, 
    TupleTypeSignature, RecordTypeSignature, EphemeralListTypeSignature,
    FunctionParameter, FunctionTypeSignature, ProjectTypeSignature, IntersectionTypeSignature, UnionTypeSignature
};
