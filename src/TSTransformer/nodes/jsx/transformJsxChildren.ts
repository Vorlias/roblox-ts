import ts from "byots";
import luau from "LuauAST";
import { diagnostics } from "Shared/diagnostics";
import { assert } from "Shared/util/assert";
import { TransformState } from "TSTransformer";
import { transformExpression } from "TSTransformer/nodes/expressions/transformExpression";
import { getKeyValue } from "TSTransformer/util/jsx/getKeyValue";
import {
	assignToMixedTablePointer,
	disableMapInline,
	disableMixedTableInline,
	MapPointer,
	MixedTablePointer,
} from "TSTransformer/util/pointer";
import { isArrayType, isMapType } from "TSTransformer/util/types";

/** `children[lengthId + keyId] = valueId` */
function createJsxAddNumericChild(
	childrenPtrValue: luau.AnyIdentifier,
	lengthId: luau.AnyIdentifier,
	key: luau.Expression,
	value: luau.Expression,
) {
	return luau.create(luau.SyntaxKind.Assignment, {
		left: luau.create(luau.SyntaxKind.ComputedIndexExpression, {
			expression: childrenPtrValue,
			index: luau.binary(lengthId, "+", key),
		}),
		operator: "=",
		right: value,
	});
}

/** `children[keyId] = valueId` */
function createJsxAddKeyChild(
	childrenPtrValue: luau.AnyIdentifier,
	keyId: luau.TemporaryIdentifier,
	valueId: luau.TemporaryIdentifier,
) {
	return luau.create(luau.SyntaxKind.Assignment, {
		left: luau.create(luau.SyntaxKind.ComputedIndexExpression, {
			expression: childrenPtrValue,
			index: keyId,
		}),
		operator: "=",
		right: valueId,
	});
}

function createJsxAddNumericChildren(
	childrenPtrValue: luau.AnyIdentifier,
	lengthId: luau.AnyIdentifier,
	expression: luau.Expression,
) {
	const keyId = luau.tempId();
	const valueId = luau.tempId();
	return luau.create(luau.SyntaxKind.ForStatement, {
		ids: luau.list.make(keyId, valueId),
		expression: luau.create(luau.SyntaxKind.CallExpression, {
			expression: luau.globals.pairs,
			args: luau.list.make(expression),
		}),
		statements: luau.list.make(createJsxAddNumericChild(childrenPtrValue, lengthId, keyId, valueId)),
	});
}

function createJsxAddAmbiguousChildren(
	childrenPtrValue: luau.AnyIdentifier,
	lengthId: luau.AnyIdentifier,
	expression: luau.Expression,
) {
	const keyId = luau.tempId();
	const valueId = luau.tempId();
	return luau.create(luau.SyntaxKind.ForStatement, {
		ids: luau.list.make(keyId, valueId),
		expression: luau.create(luau.SyntaxKind.CallExpression, {
			expression: luau.globals.pairs,
			args: luau.list.make(expression),
		}),
		statements: luau.list.make<luau.Statement>(
			luau.create(luau.SyntaxKind.IfStatement, {
				// type(keyId) == "string"
				condition: luau.create(luau.SyntaxKind.BinaryExpression, {
					left: luau.create(luau.SyntaxKind.CallExpression, {
						expression: luau.globals.type,
						args: luau.list.make(keyId),
					}),
					operator: "==",
					right: luau.strings.number,
				}),
				statements: luau.list.make(createJsxAddNumericChild(childrenPtrValue, lengthId, keyId, valueId)),
				elseBody: luau.list.make(createJsxAddKeyChild(childrenPtrValue, keyId, valueId)),
			}),
		),
	});
}

function createJsxAddAmbiguousChild(
	childrenPtrValue: luau.AnyIdentifier,
	amtChildrenSinceUpdate: number,
	lengthId: luau.AnyIdentifier,
	expression: luau.IndexableExpression,
) {
	return luau.create(luau.SyntaxKind.IfStatement, {
		condition: luau.create(luau.SyntaxKind.BinaryExpression, {
			left: luau.create(luau.SyntaxKind.CallExpression, {
				expression: luau.globals.type,
				args: luau.list.make(expression),
			}),
			operator: "==",
			right: luau.strings.table,
		}),
		statements: luau.list.make(
			luau.create(luau.SyntaxKind.IfStatement, {
				condition: luau.create(luau.SyntaxKind.BinaryExpression, {
					left: luau.create(luau.SyntaxKind.BinaryExpression, {
						left: luau.create(luau.SyntaxKind.PropertyAccessExpression, {
							expression,
							name: "props",
						}),
						operator: "~=",
						right: luau.nil(),
					}),

					operator: "and",
					right: luau.create(luau.SyntaxKind.BinaryExpression, {
						left: luau.create(luau.SyntaxKind.PropertyAccessExpression, {
							expression,
							name: "component",
						}),
						operator: "~=",
						right: luau.nil(),
					}),
				}),
				statements: luau.list.make(
					createJsxAddNumericChild(
						childrenPtrValue,
						lengthId,
						luau.number(amtChildrenSinceUpdate + 1),
						expression,
					),
				),
				elseBody: luau.list.make(createJsxAddAmbiguousChildren(childrenPtrValue, lengthId, expression)),
			}),
		),
		elseBody: luau.list.make(),
	});
}

export function transformJsxChildren(
	state: TransformState,
	children: ReadonlyArray<ts.JsxChild>,
	attributesPtr: MapPointer,
	childrenPtr: MixedTablePointer,
) {
	const lengthId = luau.tempId();
	let lengthInitialized = false;
	let amtChildrenSinceUpdate = 0;

	function updateLengthId() {
		const right = luau.unary("#", childrenPtr.value);
		if (lengthInitialized) {
			state.prereq(
				luau.create(luau.SyntaxKind.Assignment, {
					left: lengthId,
					operator: "=",
					right,
				}),
			);
		} else {
			state.prereq(
				luau.create(luau.SyntaxKind.VariableDeclaration, {
					left: lengthId,
					right,
				}),
			);
			lengthInitialized = true;
		}
		amtChildrenSinceUpdate = 0;
	}

	function disableInline() {
		if (luau.isMixedTable(childrenPtr.value)) {
			if (luau.isMap(attributesPtr.value) && !luau.list.isEmpty(attributesPtr.value.fields)) {
				disableMapInline(state, attributesPtr);
			}
			disableMixedTableInline(state, childrenPtr);
			updateLengthId();
		}
	}

	for (let i = 0; i < children.length; i++) {
		const child = children[i];
		if (ts.isJsxText(child)) {
			if (!child.containsOnlyTriviaWhiteSpaces) {
				state.addDiagnostic(diagnostics.noJsxText(child));
			}
			continue;
		}

		// not available when jsxFactory is set
		assert(!ts.isJsxFragment(child));

		if (ts.isJsxExpression(child)) {
			const innerExp = child.expression;
			if (innerExp) {
				const [expression, prereqs] = state.capture(() => transformExpression(state, innerExp));
				if (!luau.list.isEmpty(prereqs)) {
					state.prereqList(prereqs);
					disableInline();
				}

				if (child.dotDotDotToken) {
					// spread children
					disableInline();
					assert(luau.isAnyIdentifier(childrenPtr.value));
					state.prereqList(prereqs);
					state.prereq(createJsxAddAmbiguousChildren(childrenPtr.value, lengthId, expression));
				} else {
					const type = state.getType(innerExp);

					if (state.roactSymbolManager && state.roactSymbolManager.isElementType(type)) {
						if (luau.isMixedTable(childrenPtr.value)) {
							luau.list.push(childrenPtr.value.fields, expression);
						} else {
							state.prereq(
								createJsxAddNumericChild(
									childrenPtr.value,
									lengthId,
									luau.number(amtChildrenSinceUpdate + 1),
									expression,
								),
							);
						}
						amtChildrenSinceUpdate++;
					} else if (isArrayType(state, type)) {
						disableInline();
						assert(luau.isAnyIdentifier(childrenPtr.value));
						state.prereq(createJsxAddNumericChildren(childrenPtr.value, lengthId, expression));
					} else if (isMapType(state, type)) {
						disableInline();
						assert(luau.isAnyIdentifier(childrenPtr.value));
						state.prereq(createJsxAddAmbiguousChildren(childrenPtr.value, lengthId, expression));
					} else {
						disableInline();
						assert(luau.isAnyIdentifier(childrenPtr.value));
						state.prereq(
							createJsxAddAmbiguousChild(
								childrenPtr.value,
								amtChildrenSinceUpdate,
								lengthId,
								state.pushToVarIfNonId(expression),
							),
						);
					}
				}
				if (i < children.length - 1) {
					updateLengthId();
				}
			}
		} else {
			const [expression, prereqs] = state.capture(() => transformExpression(state, child));
			if (!luau.list.isEmpty(prereqs)) {
				disableInline();
			}
			state.prereqList(prereqs);

			const key = getKeyValue(child);
			if (key) {
				assignToMixedTablePointer(state, childrenPtr, luau.string(key), expression);
			} else {
				if (luau.isMixedTable(childrenPtr.value)) {
					luau.list.push(childrenPtr.value.fields, expression);
				} else {
					state.prereq(
						createJsxAddNumericChild(
							childrenPtr.value,
							lengthId,
							luau.number(amtChildrenSinceUpdate + 1),
							expression,
						),
					);
				}
				amtChildrenSinceUpdate++;
			}
		}
	}
}