/**
 * Copyright (c) Meta Platforms, Inc. and affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 */

import { CompilerError } from "../CompilerError";
import {
  BlockId,
  Effect,
  GeneratedSource,
  HIRFunction,
  Instruction,
} from "./HIR";
import { markPredecessors, removeUnreachableFallthroughs } from "./HIRBuilder";
import { mapOptionalFallthroughs } from "./visitors";

/**
 * Merges sequences of blocks that will always execute consecutively —
 * ie where the predecessor always transfers control to the successor
 * (ie ends in a goto) and where the predecessor is the only predecessor
 * for that successor (ie, there is no other way to reach the successor).
 *
 * Note that this pass leaves value/loop blocks alone because they cannot
 * be merged without breaking the structure of the high-level terminals
 * that reference them.
 *
 * TODO @josephsavona make value blocks explicit (eg a `kind` on Block).
 */
export function mergeConsecutiveBlocks(fn: HIRFunction): void {
  const merged = new MergedBlocks();
  for (const [, block] of fn.body.blocks) {
    if (fn.env.enableOptimizeFunctionExpressions) {
      for (const instr of block.instructions) {
        if (instr.value.kind === "FunctionExpression") {
          mergeConsecutiveBlocks(instr.value.loweredFunc);
        }
      }
    }

    // Can only merge blocks with a single predecessor, can't merge
    // value blocks
    if (block.kind !== "block" || block.preds.size !== 1) {
      continue;
    }
    const originalPredecessorId = Array.from(block.preds)[0]!;
    const predecessorId = merged.get(originalPredecessorId);
    const predecessor = fn.body.blocks.get(predecessorId);
    CompilerError.invariant(predecessor !== undefined, {
      reason: `Expected predecessor ${predecessorId} to exist`,
      description: null,
      loc: null,
      suggestions: null,
    });
    if (predecessor.terminal.kind !== "goto" || predecessor.kind !== "block") {
      // The predecessor is not guaranteed to transfer control to this block,
      // they aren't consecutive.
      continue;
    }

    // Replace phis in the merged block with canonical assignments to the single operand value
    for (const phi of block.phis) {
      CompilerError.invariant(phi.operands.size === 1, {
        reason: `Found a block with a single predecessor but where a phi has multiple (${phi.operands.size}) operands`,
        description: null,
        loc: null,
        suggestions: null,
      });
      const operand = Array.from(phi.operands.values())[0]!;
      const instr: Instruction = {
        id: predecessor.terminal.id,
        lvalue: {
          kind: "Identifier",
          identifier: phi.id,
          effect: Effect.ConditionallyMutate,
          loc: GeneratedSource,
        },
        value: {
          kind: "LoadLocal",
          place: {
            kind: "Identifier",
            identifier: operand,
            effect: Effect.Read,
            loc: GeneratedSource,
          },
          loc: GeneratedSource,
        },
        loc: GeneratedSource,
      };
      predecessor.instructions.push(instr);
    }

    predecessor.instructions.push(...block.instructions);
    predecessor.terminal = block.terminal;
    merged.merge(block.id, predecessorId);
    fn.body.blocks.delete(block.id);
  }
  markPredecessors(fn.body);
  for (const [, block] of fn.body.blocks) {
    mapOptionalFallthroughs(block.terminal, (blockId) => merged.get(blockId));
  }
  removeUnreachableFallthroughs(fn.body);
}

class MergedBlocks {
  #map: Map<BlockId, BlockId> = new Map();

  /**
   * Record that @param block was merged into @param into.
   */
  merge(block: BlockId, into: BlockId): void {
    const target = this.get(into);
    this.#map.set(block, target);
  }

  /**
   * Get the id of the block that @param block has been merged into.
   * This is transitive, in the case that eg @param block was merged
   * into a block which later merged into another block.
   */
  get(block: BlockId): BlockId {
    let current = block;
    while (this.#map.has(current)) {
      current = this.#map.get(current) ?? current;
    }
    return current;
  }
}
