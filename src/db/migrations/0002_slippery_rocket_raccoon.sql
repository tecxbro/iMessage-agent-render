CREATE UNIQUE INDEX "execution_tasks_chain_name_unique" ON "execution_tasks" USING btree ("chain_id","name");
